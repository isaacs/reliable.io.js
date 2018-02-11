'use strict'

if(!global.poolUint8ArrayBuffer) {
  global.poolUint8ArrayBuffer = {}
}

// key is array size, value is array of available unit8 arrays
const pool = global.poolUint8ArrayBuffer

module.exports.malloc = function(n) {
  if (!pool[n])
    pool[n] = []

  if (pool[n].length)
    return pool[n].pop()

  return new Uint8Array(n)
}

module.exports.free = function(array) {
  if(!(array instanceof Uint8Array)) {
    throw new Error('invalid pool entry!')
  }

  const n = array.byteLength
  if (!pool[n])
    pool[n] = []
  pool[n].push(array)
}

// get the underlying data structure. solely for debugging
module.exports.get = function() {
  return pool
}
