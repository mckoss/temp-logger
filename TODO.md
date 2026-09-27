# Follow-up work

These are possible follow-ups, not changes promised or approved for this session.

- [ ] Validate chip-specific CPU/GPU mappings on additional Apple Silicon Macs.
  Live comparison on the development M5 Ultra matched smctemp averages and
  exposed 15 CPU and 7 GPU temperature sensors; these are not a per-core census.
  Keep missing sensors unavailable and record model/key/count evidence.
- [ ] Compare PD0R power against an external wall meter at idle and under load.
  Until validated, keep watts and kWh labeled as input-rail estimates and preserve
  measurement coverage. Do not imply whole-machine wall consumption.
- [ ] Decide whether to rename the native `Temp Logger.app` bundle and menu to
  Mac Thermals. Preserve Dock behavior, startup, single-instance protection,
  existing data, and launchd services if this is implemented.
- [ ] Consider a visible history boundary/filter for the temperature-source
  correction introduced in v1.5.0. Earlier PMU temperature history is retained
  and not comparable; do not rewrite it as mapped-sensor data. Fan/utilization/
  power history is unaffected.

## Decisions to preserve

- Store temperatures in Celsius; Fahrenheit is display-only.
- Show mapped-sensor averages in cards, smaller sensor min–max ranges below,
  and min–max whiskers on temperature plots.
- Both chart groups stack temperatures, utilization, fans, and power with one
  y-axis per panel and aligned time bounds. Never reintroduce dual y-axes.
- CPU utilization is normalized across all cores; retain one-second live samples
  in memory and save five-minute averages/peaks. Missing data is not zero.
- Temperature Zones are editable display bands, not Apple throttle limits.
  Defaults: Z1 <60°C, Z2 60–<80°C, Z3 80–<95°C, Z4 ≥95°C.
  Use green/yellow/orange/red for card colors, bright axis strips, and 20%-opacity
  temperature-chart backgrounds; keep the site explanation to range definitions.
- The two fan channels remain generically numbered. No verified software-channel
  to physical-position mapping was found; do not label them CPU/GPU fans.
- The logger is a loopback Node server on manifest port 49173, supervised by
  launchd. The native window uses WKWebView; closing it leaves logging running.

## Verification notes

- Local checks comprise 56 unit and 34 browser tests plus native compilation.
- Slow CI runners exposed chart-initialization races in browser assertions.
  Wait for each chart's data before checking it; do not mask failures with retries.
- Real-time buffers are memory-only and reset at restart. Existing saved history
  remains available. Shutdown/crash can lose the unfinished workload interval.
