'use strict'

module.exports = {
  PROTOCOL_ID: 0X1B4101D8, // network protocol magic number
  BYTES_PER_SECOND: 32000,

  // based on MTU for ipv4/6 networks. staying under MTU reduces packet loss.
  MAX_PACKET_SIZE: 1024,

  PACKETS: {
    RELIABLE: 1,
    UNRELIABLE: 2,
    CHUNK: 3,
    CHUNK_SLICE: 4,
    CHUNK_ACK: 5
  }
}
