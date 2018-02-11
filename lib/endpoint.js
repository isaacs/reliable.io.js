'use strict'

const copyBytes        = require('./copy-bytes')
const pack             = require('./uint8array-pack')
const pool             = require('./pool-uint8array')
const reliable_assert  = require('./assert')
const sb               = require('./sequence-buffer')
const uint16_increment = require('./uint16-increment')
const unpack           = require('./uint8array-unpack')


const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_SENT =                  0
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_RECEIVED =              1
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_ACKED =                 2
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_STALE =                 3
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_INVALID =               4
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_TOO_LARGE_TO_SEND =     5
const RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_TOO_LARGE_TO_RECEIVE =  6
const RELIABLE_ENDPOINT_COUNTER_NUM_FRAGMENTS_SENT =                7
const RELIABLE_ENDPOINT_COUNTER_NUM_FRAGMENTS_RECEIVED =            8
const RELIABLE_ENDPOINT_COUNTER_NUM_FRAGMENTS_INVALID =             9
const RELIABLE_ENDPOINT_NUM_COUNTERS = 10
const RELIABLE_MAX_PACKET_HEADER_BYTES = 8


// fills a reliable_config_t object
function reliable_default_config(config={}) {
  reliable_assert(config)

  config.name = 'endpoint'  // max length 256
  config.context = null
  config.index = 0
  config.max_packet_size = 1024 //16 * 1024
  config.ack_buffer_size = 256
  config.sent_packets_buffer_size = 256
  config.received_packets_buffer_size = 256
  config.rtt_smoothing_factor = 0.0025
  config.packet_loss_smoothing_factor = 0.1
  config.bandwidth_smoothing_factor = 0.1
  config.packet_header_size = 28        // note: UDP over IPv4 = 20 + 8 bytes, UDP over IPv6 = 40 + 8 bytes
  config.transmit_packet_function = null
  config.process_packet_function = null
}


// @param double time
function reliable_endpoint_create(config, time ) {

  reliable_assert( config )
  reliable_assert( config.max_packet_size > 0 )
  reliable_assert( config.ack_buffer_size > 0 )
  reliable_assert( config.sent_packets_buffer_size > 0 )
  reliable_assert( config.received_packets_buffer_size > 0 )
  reliable_assert( config.transmit_packet_function)
  reliable_assert( config.process_packet_function)

  const sent_packet_data_descriptor = {
    time: 0,          // double
    acked : 1,        // uint32
    packet_bytes : 31 // uint32
  }

  const received_packet_data_descriptor = {
    time: 0,        // double
    packet_bytes: 0 // uint32
  }

  const endpoint = {
    config,
    time,
    rtt: 0.0,
    packet_loss: 0.0,
    sent_bandwidth_kbps: 0.0,
    received_bandwidth_kbps: 0.0,
    acked_bandwidth_kbps: 0.0,
    num_acks: 0,  // int
    acks: new Uint16Array(config.ack_buffer_size),
    sequence: 0,  // uint16
    sent_packets: sb.reliable_sequence_buffer_create(config.sent_packets_buffer_size, sent_packet_data_descriptor),
    received_packets: sb.reliable_sequence_buffer_create(config.received_packets_buffer_size, received_packet_data_descriptor),
    counters: new Array(RELIABLE_ENDPOINT_NUM_COUNTERS)  // uint64
  }

  reliable_assert( endpoint)

  endpoint.counters.fill(0)

  return endpoint
}


// @param uint8array packet_data
// @param uint16 sequence
// @param uint16 ack
// @param uint32 ack_bits
// @return int written header data bytes
function reliable_write_packet_header(packet_data, sequence, ack, ack_bits) {
  //uint8_t * p = packet_data
  const p = pack(packet_data)

  //let sequence_difference = uint16_increment(sequence, -ack)
  //if (sequence_difference < 0)
  //  sequence_difference += 65536
  //if (sequence_difference <= 255)
  //  prefix_byte |= (1<<5)

  //reliable_write_uint8( &p, prefix_byte )

  p.packUint16(sequence)

  //if (sequence_difference <= 255)
  //  p.packUint8(sequence_difference)
  //else
    p.packUint16(ack)

  p.packUint32(ack_bits)

  //reliable_assert( p - packet_data <= RELIABLE_MAX_PACKET_HEADER_BYTES)
  return RELIABLE_MAX_PACKET_HEADER_BYTES
}


// @param Uint8Array packet_data
// @param int packet_bytes
function reliable_endpoint_send_packet(endpoint, packet_data, packet_bytes) {
  reliable_assert( endpoint )
  reliable_assert( packet_data )
  reliable_assert( packet_bytes > 0 )

  if (packet_bytes > endpoint.config.max_packet_size)
    return console.error(`[${endpoint.config.name}] packet too large to send. packet is ${packet_bytes} bytes, maximum is ${endpoint.config.max_packet_size}\n`)

  let sequence = endpoint.sequence
  endpoint.sequence = uint16_increment(endpoint.sequence)


  const ack_struct = { ack: 0, ack_bits: 0 }
  sb.reliable_sequence_buffer_generate_ack_bits(endpoint.received_packets, ack_struct)

  //console.error(`[${endpoint.config.name}] sending packet ${sequence} eps${endpoint.sequence}\n`)

  let sent_packet_data = sb.reliable_sequence_buffer_insert(endpoint.sent_packets, sequence)
  reliable_assert( sent_packet_data )

  sent_packet_data.time = endpoint.time
  sent_packet_data.packet_bytes = endpoint.config.packet_header_size + packet_bytes
  sent_packet_data.acked = 0

  // regular packet
  //console.log(`[${endpoint.config.name}] sending packet ${sequence} without fragmentation`)

  const transmit_packet_data = pool.malloc(packet_bytes + RELIABLE_MAX_PACKET_HEADER_BYTES)

  const packet_header_bytes = reliable_write_packet_header(transmit_packet_data, sequence, ack_struct.ack, ack_struct.ack_bits)

  // API: memcpy(dest, src, count)
  //memcpy( transmit_packet_data + packet_header_bytes, packet_data, packet_bytes )

  // API: copyBytes(dest, src, destOffset, srcOffset, count)
  //console.error('dest size:', transmit_packet_data.byteLength, 'src size:', packet_data.byteLength, 'destOffset:', packet_header_bytes, 'count', packet_bytes)
  copyBytes(transmit_packet_data.buffer, packet_data.buffer, packet_header_bytes, 0, packet_bytes)

  endpoint.config.transmit_packet_function(endpoint.config.context, endpoint.config.index, sequence, transmit_packet_data, packet_header_bytes + packet_bytes)

  endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_SENT]++
}


// @param string name
// @param uint8array packet_data
// @param int packet_bytes
// @param object read_struct
// @param uint16* read_struct.sequence
// @param uint16* read_struct.ack
// @param uint32* read_struct.ack_bits
// @return int bytes read from packet header. -1 on error
function reliable_read_packet_header(name, packet_data, packet_bytes, read_struct) {
  if (packet_bytes < RELIABLE_MAX_PACKET_HEADER_BYTES) {
    console.error(`[${name}] packet too small for packet header (1)\n`)
    return -1
  }

  let p = unpack(packet_data)

  read_struct.sequence = p.unpackUint16()
  read_struct.ack = p.unpackUint16()
  read_struct.ack_bits = p.unpackUint32()

  return RELIABLE_MAX_PACKET_HEADER_BYTES
}


function reliable_sequence_buffer_test_insert(sequence_buffer, sequence) {
  let next = uint16_increment(sequence_buffer.sequence, -sequence_buffer.num_entries)
  return sb.reliable_sequence_less_than(sequence, next) ? 0 : 1
}


// @param object endpoint
// @param uint8array packet_data
// @param int packet_bytes
function reliable_endpoint_receive_packet(endpoint, packet_data, packet_bytes) {
  reliable_assert( endpoint )
  reliable_assert( packet_data )
  reliable_assert( packet_bytes > 0 )

  if (packet_bytes > endpoint.config.max_packet_size) {
    console.error(`[${endpoint.config.name}] packet too large to receive. packet is ${packet_bytes} bytes, maximum is ${endpoint.config.max_packet_size}\n`)
    endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_TOO_LARGE_TO_RECEIVE]++
    return
  }

  endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_RECEIVED]++

  const read_struct = { sequence: 0, ack: 0, ack_bits: 0 }  // uint16, uint16, uint32
  const packet_header_bytes = reliable_read_packet_header(endpoint.config.name, packet_data, packet_bytes, read_struct)

  if (packet_header_bytes < 0) {
    console.error(`[${endpoint.config.name}] ignoring invalid packet. could not read packet header\n`)
    endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_INVALID]++
    return
  }

  if (!reliable_sequence_buffer_test_insert(endpoint.received_packets, read_struct.sequence)) {
    console.error(`[${endpoint.config.name}] ignoring stale packet ${read_struct.sequence}\n`)
    endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_STALE]++
    return
  }

  //console.log(`[${endpoint.config.name}] processing packet ${read_struct.sequence}\n`)

  if (endpoint.config.process_packet_function( endpoint.config.context,
                                               endpoint.config.index,
                                               read_struct.sequence,
                                               packet_data,
                                               packet_bytes ) )
  {
    //console.log(`[${endpoint.config.name}] process packet ${read_struct.sequence} successful\n`)
    let received_packet_data = sb.reliable_sequence_buffer_insert(endpoint.received_packets, read_struct.sequence)

    reliable_assert(received_packet_data)

    received_packet_data.time = endpoint.time
    received_packet_data.packet_bytes = endpoint.config.packet_header_size + packet_bytes

    //console.error('packet_bytes:', packet_bytes, 'headersize:', endpoint.config.packet_header_size)

    for (let i = 0; i < 32; ++i ) {
      if ( read_struct.ack_bits & 1 ) {
        let ack_sequence = uint16_increment(read_struct.ack, -i)

        let sent_packet_data = sb.reliable_sequence_buffer_find(endpoint.sent_packets, ack_sequence)

        if (sent_packet_data && !sent_packet_data.acked && endpoint.num_acks < endpoint.config.ack_buffer_size) {
          //console.log(`[${endpoint.config.name}] acked packet ${ack_sequence}\n`)
          endpoint.acks[endpoint.num_acks++] = ack_sequence
          endpoint.counters[RELIABLE_ENDPOINT_COUNTER_NUM_PACKETS_ACKED]++
          sent_packet_data.acked = 1

          let rtt = (endpoint.time - sent_packet_data.time) * 1000.0
          reliable_assert(rtt >= 0.0)
          if ( ( endpoint.rtt == 0.0 && rtt > 0.0 ) || Math.abs( endpoint.rtt - rtt ) < 0.00001 )
            endpoint.rtt = rtt
          else
            endpoint.rtt += ( rtt - endpoint.rtt ) * endpoint.config.rtt_smoothing_factor
        }
      }
      read_struct.ack_bits >>= 1
    }

  } else {
    console.error(`[${endpoint.config.name}] process packet failed\n`)
  }
}


function reliable_endpoint_reset(endpoint) {
  reliable_assert(endpoint)

  endpoint.num_acks = 0
  endpoint.sequence = 0

  endpoint.acks.fill(0)

  sb.reliable_sequence_buffer_reset(endpoint.sent_packets)
  sb.reliable_sequence_buffer_reset(endpoint.received_packets)
}


// @param object endpoint
// @param float time
function reliable_endpoint_update(endpoint, time) {
  // TODO
}


module.exports = {
  reliable_default_config,
  reliable_endpoint_create,
  reliable_write_packet_header,
  reliable_endpoint_send_packet,
  reliable_read_packet_header,
  reliable_endpoint_receive_packet,
  reliable_endpoint_reset,
  reliable_endpoint_update
}
