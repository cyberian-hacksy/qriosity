// Node-side test runner (`pnpm test`). Runs every DOM-free test — the same
// functions the browser suite (?test) registers, minus the ones that need a
// real DOM, camera, or WASM-worker plumbing (those still run via ?test; see
// CLAUDE.md "Testing"). CI runs this on every push.
//
// Add new DOM-free test modules here AND to src/test-suite.js.

const SUITES = [
  ['../src/lib/prng.js', ['testPRNG']],
  ['../src/lib/packet.js', ['testPacketRoundtrip']],
  ['../src/lib/xor.js', ['testXorBytesInto']],
  ['../src/lib/metadata.js', [
    'testMetadataRoundtrip', 'testMetadataNoRedundancyFlag',
    'testMetadataRepairIdleFlag', 'testMetadataCompressionFlag'
  ]],
  ['../src/lib/encoder.js', ['testEncoder', 'testEncoderNoRedundancy']],
  ['../src/lib/fountain-symbol.js', ['testFountainRippleVariant']],
  ['../src/lib/precode.js', [
    'testParityMap', 'testParityRecovery', 'testGF2SolverSmall',
    'testGF2SolverLarge', 'testSourceToParityAdjacency'
  ]],
  ['../src/lib/decoder.tests.js', [
    'testCodecRoundtrip', 'testCodecRoundtripCompressed', 'testCodecRoundtripWithLoss',
    'testCodecRoundtripDeferredMetadata', 'testCodecRoundtripNoRedundancy',
    'testNoRedundancyLoopRecovers', 'testTailSolverTriggerAllowsWiderDenseBinaryTail'
  ]],
  ['../src/lib/qr-modules.tests.js', ['testQrModulesBinaryRoundtrip', 'testQrModulesStableGeometry']],
  ['../src/lib/golden-vectors.tests.js', [
    'testGoldenPacket', 'testGoldenMetadata', 'testGoldenSymbolIndices',
    'testGoldenQrMatrix', 'testGoldenGzipDecode'
  ]],
  ['../src/lib/shared/compression.tests.js', [
    'testCompressionRoundtrip', 'testCompressionSkipsSmallAndPrecompressed',
    'testCompressionIncompressibleFallback', 'testDecompressCeilingAborts'
  ]],
  ['../src/lib/shared/wake-lock.tests.js', ['testWakeLockStateMachine', 'testWakeLockSurvivesMissingApi']],
  ['../src/lib/shared/no-signal.tests.js', ['testNoSignalHintLifecycle', 'testNoSignalHintEndsOnDecode']],
  ['../src/lib/shared/download.tests.js', ['testSafeFileName']],
  ['../src/lib/shared/transfer-progress.tests.js', [
    'testProgressMonotonicAndBounded', 'testProgressMovesWhileSolvedStalls', 'testEtaBehaviour'
  ]],
  ['../src/lib/shared/snippet.tests.js', ['testSnippetRoundtrip', 'testSnippetLimits']],
  ['../src/lib/shared/decode-worker-pool.tests.js', [
    'testDecodeWorkerPoolSubmitAndDrain', 'testDecodeWorkerPoolResize',
    'testDecodeWorkerPoolWorkerFailure', 'testDecodeWorkerPoolJamDetector'
  ]]
]

const results = {}
let failures = 0

for (const [modulePath, testNames] of SUITES) {
  let module
  try {
    module = await import(new URL(modulePath, import.meta.url))
  } catch (err) {
    console.error('LOAD FAILED: ' + modulePath + ' — ' + err.message)
    for (const name of testNames) { results[name] = false; failures++ }
    continue
  }
  for (const name of testNames) {
    try {
      const pass = await module[name]()
      results[name] = pass === true
      if (pass !== true) failures++
    } catch (err) {
      console.error('THREW: ' + name + ' — ' + err.message)
      results[name] = false
      failures++
    }
  }
}

const total = Object.keys(results).length
console.log('\n=== NODE TEST RESULTS ===')
console.log((total - failures) + '/' + total + ' passed')
if (failures > 0) {
  console.log('Failing:', Object.entries(results).filter(([, v]) => !v).map(([k]) => k).join(', '))
}
process.exit(failures > 0 ? 1 : 0)
