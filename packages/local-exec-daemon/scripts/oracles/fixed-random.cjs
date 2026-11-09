// t171 test-only preload (oracle harness, never production): pins Math.random so the full-jitter
// silentRenewalBackoff / backend-return delays (Pu D:78223–78250, random D:78241; D:177900–177906)
// are deterministic for our daemon under the retry-expiry oracle. Loaded with `node --require` only
// when PROBE_FIXED_RANDOM is set and PROBE_MAIN points at our dist.
const v = Number(process.env.PROBE_FIXED_RANDOM);
if (Number.isFinite(v) && v >= 0 && v < 1) Math.random = () => v;
