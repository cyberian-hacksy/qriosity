import {
  ARQ_NOTIFY_CHARACTERISTIC_UUID,
  SERVICE_UUID
} from '../backchannel.js'
import { fragment, Reassembler } from '../arq-fragment.js'

export const ARQ_DEVICE_NAME = 'BeamMeUp-ARQ'
const ARQ_NAME_PREFIX = 'BeamMeUp'
const CONNECT_TIMEOUT_MS = 5000

// Survives across transport instances (each Connect click makes a fresh
// sender), so an in-session reconnect can skip the chooser entirely.
let grantedDevice = null

export function getBleGattRequestOptions() {
  // OR-filters: the helper shows up whether Chrome sees its advertised name
  // or its service UUID, whichever the platform puts in the advertisement.
  return {
    filters: [
      { namePrefix: ARQ_NAME_PREFIX },
      { services: [SERVICE_UUID] }
    ],
    optionalServices: [SERVICE_UUID]
  }
}

function pickArqDevice(devices) {
  if (!Array.isArray(devices)) return null
  const named = devices.find(d => typeof d?.name === 'string' && d.name.startsWith(ARQ_NAME_PREFIX))
  if (named) return named
  // A Windows helper advertises under the PC's adapter name (renaming needs
  // admin + name_overwrite), so trust a sole granted device regardless of
  // name — this origin only ever requests the helper, and a wrong pick
  // self-heals via the stale-GATT chooser fallback.
  return devices.length === 1 && devices[0] ? devices[0] : null
}

async function connectWithTimeout(device, timeoutMs = CONNECT_TIMEOUT_MS) {
  let timer
  try {
    return await Promise.race([
      device.gatt.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { device.gatt.disconnect() } catch { /* never connected */ }
          reject(new Error('BLE connect timed out'))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Connect ladder: previously granted device (flag-gated getDevices), then the
// session cache, then the filtered chooser. Tier failures fall through so the
// worst case is just today's chooser.
async function acquireArqDevice(env) {
  const candidates = []
  if (env.getDevices) {
    try {
      const granted = pickArqDevice(await env.getDevices())
      if (granted) candidates.push(granted)
    } catch { /* flag-gated API — treat as unavailable */ }
  }
  if (env.cachedDevice && !candidates.includes(env.cachedDevice)) {
    candidates.push(env.cachedDevice)
  }
  for (const device of candidates) {
    env.onStatus?.('reconnecting')
    try {
      await connectWithTimeout(device, env.timeoutMs)
      return { device, viaChooser: false }
    } catch { /* stale or out of range — next tier */ }
  }
  env.onStatus?.('select-device')
  return { device: await env.requestDevice(getBleGattRequestOptions()), viaChooser: true }
}

// A tier-1/2 device can connect yet fail GATT setup (helper restarted with
// stale services); drop the cache and retry once via the chooser.
async function establishArqConnection(env, setup) {
  const attempt = await acquireArqDevice(env)
  try {
    await setup(attempt.device)
    return attempt.device
  } catch (err) {
    if (attempt.viaChooser) throw err
    env.clearCache?.()
    try { attempt.device.gatt.disconnect() } catch { /* already gone */ }
    env.onStatus?.('select-device')
    const device = await env.requestDevice(getBleGattRequestOptions())
    await setup(device)
    return device
  }
}

export const _internals = { pickArqDevice, connectWithTimeout, acquireArqDevice, establishArqConnection }

export function testBleGattSenderUsesFilteredDiscovery() {
  const opts = getBleGattRequestOptions()
  const hasNameFilter = !!opts.filters?.some(f =>
    f.namePrefix && ARQ_DEVICE_NAME.startsWith(f.namePrefix))
  const hasServiceFilter = !!opts.filters?.some(f => f.services?.[0] === SERVICE_UUID)
  const pass = hasNameFilter && hasServiceFilter &&
    opts.optionalServices?.[0] === SERVICE_UUID &&
    !opts.acceptAllDevices
  console.log('ble gatt sender filtered discovery:', pass ? 'PASS' : 'FAIL')
  return pass
}

function makeFakeBleDevice(name, opts = {}) {
  const device = { name, connectCalls: 0, disconnectCalls: 0 }
  device.gatt = {
    connected: false,
    connect: opts.connect || (async () => {
      device.connectCalls++
      device.gatt.connected = true
      return device.gatt
    }),
    disconnect: () => {
      device.disconnectCalls++
      device.gatt.connected = false
    }
  }
  return device
}

export function testBleGattPickArqDevicePrefersNamePrefix() {
  const arq = { name: 'BeamMeUp-ARQ' }
  const pass = _internals.pickArqDevice([{ name: 'AirPods' }, arq]) === arq &&
    _internals.pickArqDevice([{ name: 'AirPods' }, {}]) === null &&
    _internals.pickArqDevice([]) === null &&
    _internals.pickArqDevice(undefined) === null
  console.log('ble gatt pick arq device:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBleGattPickArqDeviceFallsBackToSoleGrantedDevice() {
  const pcNamed = { name: 'DESKTOP-ABC123', gatt: {} }
  const pass = _internals.pickArqDevice([pcNamed]) === pcNamed &&
    _internals.pickArqDevice([pcNamed, { name: 'AirPods', gatt: {} }]) === null
  console.log('ble gatt pick arq device sole granted fallback:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testBleGattAcquireSkipsChooserForGrantedDevice() {
  const granted = makeFakeBleDevice('BeamMeUp-ARQ')
  let chooserCalls = 0
  const res = await _internals.acquireArqDevice({
    getDevices: async () => [makeFakeBleDevice('Other'), granted],
    cachedDevice: null,
    requestDevice: async () => { chooserCalls++; return makeFakeBleDevice('BeamMeUp-ARQ') },
    timeoutMs: 50
  })
  const pass = res.device === granted && res.viaChooser === false &&
    chooserCalls === 0 && granted.connectCalls === 1
  console.log('ble gatt acquire skips chooser for granted device:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testBleGattAcquireFallsBackToSessionCache() {
  const cached = makeFakeBleDevice('BeamMeUp-ARQ')
  let chooserCalls = 0
  const res = await _internals.acquireArqDevice({
    getDevices: null,
    cachedDevice: cached,
    requestDevice: async () => { chooserCalls++; return makeFakeBleDevice('BeamMeUp-ARQ') },
    timeoutMs: 50
  })
  const pass = res.device === cached && res.viaChooser === false && chooserCalls === 0
  console.log('ble gatt acquire falls back to session cache:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testBleGattAcquireTimesOutToChooser() {
  const stale = makeFakeBleDevice('BeamMeUp-ARQ', { connect: () => new Promise(() => {}) })
  const fresh = makeFakeBleDevice('BeamMeUp-ARQ')
  const statuses = []
  let chooserCalls = 0
  const res = await _internals.acquireArqDevice({
    getDevices: null,
    cachedDevice: stale,
    requestDevice: async () => { chooserCalls++; return fresh },
    timeoutMs: 5,
    onStatus: s => statuses.push(s)
  })
  const pass = res.device === fresh && res.viaChooser === true &&
    chooserCalls === 1 && stale.disconnectCalls >= 1 &&
    statuses[0] === 'reconnecting' && statuses.includes('select-device')
  console.log('ble gatt acquire times out to chooser:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testBleGattStaleGattFallsBackToChooser() {
  const cached = makeFakeBleDevice('BeamMeUp-ARQ')
  const chooserDev = makeFakeBleDevice('BeamMeUp-ARQ')
  let cleared = 0
  const setupCalls = []
  const device = await _internals.establishArqConnection({
    getDevices: null,
    cachedDevice: cached,
    requestDevice: async () => chooserDev,
    clearCache: () => { cleared++ },
    timeoutMs: 50
  }, async dev => {
    setupCalls.push(dev)
    if (dev === cached) throw new Error('stale services')
  })
  const pass = device === chooserDev && cleared === 1 && setupCalls.length === 2
  console.log('ble gatt stale gatt falls back to chooser:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBleGattSenderCopiesNotificationBuffer() {
  const msg = new Uint8Array(80).map((_, i) => (i * 11) & 0xFF)
  const frags = fragment(msg, 7, 20)
  const shared = new Uint8Array(Math.max(...frags.map(f => f.length)))
  const transport = new BleGattSenderTransport()
  let out = null
  transport.onMessage(bytes => { out = bytes })

  for (const frag of frags) {
    shared.fill(0)
    shared.set(frag)
    transport.handleNotification({ target: { value: new DataView(shared.buffer, 0, frag.length) } })
  }

  const pass = out &&
    out.length === msg.length &&
    out.every((v, i) => v === msg[i])
  console.log('ble gatt sender copies notification buffer:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

export class BleGattSenderTransport {
  constructor() {
    this.device = null
    this.server = null
    this.characteristic = null
    this.cb = null
    this.reassembler = new Reassembler()
    this.onStatus = null
    this.onDisconnect = null
    this.handleNotification = this.handleNotification.bind(this)
    this.handleDisconnected = this.handleDisconnected.bind(this)
  }

  async init(session = {}) {
    this.onStatus = session.onStatus || null
    this.onDisconnect = session.onDisconnect || null
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser — use Chrome or Edge')
    }

    const device = await establishArqConnection({
      getDevices: navigator.bluetooth.getDevices?.bind(navigator.bluetooth),
      cachedDevice: grantedDevice,
      requestDevice: opts => navigator.bluetooth.requestDevice(opts),
      clearCache: () => { grantedDevice = null },
      timeoutMs: CONNECT_TIMEOUT_MS,
      onStatus: s => this.onStatus?.(s)
    }, dev => this.setupGatt(dev))
    grantedDevice = device
    this.onStatus?.('connected')
  }

  async setupGatt(device) {
    this.device = device
    device.addEventListener('gattserverdisconnected', this.handleDisconnected)
    try {
      this.onStatus?.('connecting')
      this.server = device.gatt.connected ? device.gatt : await device.gatt.connect()
      const service = await this.server.getPrimaryService(SERVICE_UUID)
      this.characteristic = await service.getCharacteristic(ARQ_NOTIFY_CHARACTERISTIC_UUID)
      this.characteristic.addEventListener('characteristicvaluechanged', this.handleNotification)
      await this.characteristic.startNotifications()
    } catch (err) {
      device.removeEventListener('gattserverdisconnected', this.handleDisconnected)
      this.device = null
      this.server = null
      this.characteristic = null
      throw err
    }
  }

  onMessage(cb) {
    this.cb = cb
  }

  handleNotification(event) {
    const view = event.target.value
    const frag = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
    const msg = this.reassembler.ingest(frag)
    if (msg && this.cb) this.cb(msg)
  }

  handleDisconnected() {
    this.onStatus?.('disconnected')
    this.onDisconnect?.()
  }

  close() {
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.handleNotification)
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected)
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
    this.characteristic = null
    this.server = null
    this.device = null
    this.reassembler = new Reassembler()
  }
}
