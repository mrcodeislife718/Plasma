# Plasma ecosystem role

Plasma is the Cannon interoperability and foreign-function boundary.

## Intent

Cannon should not become isolated from existing software ecosystems. Plasma lets Cannon/Cannon+ call into and be called from foreign languages, runtimes, libraries and operating-system APIs through stable contracts rather than ad-hoc wrappers.

Plasma owns value/ABI contracts, generated bindings, marshaling, lifecycle and ownership control, async bridging, error translation and source-aware diagnostics.

Initial targets include JavaScript/Node, C, C++, Python, JVM/Java, Ruby, PHP, Perl, WebAssembly and native operating-system APIs.

## Relationships

- Cannon/Cannon+ are the native languages on one side of the bridge.
- Nova understands and diagnoses interop boundaries.
- Parallel exposes the runtime module ABI.
- Velocity uses Plasma for native modules/plugins across web, mobile and desktop targets.
- Cortex surfaces cross-boundary diagnostics and debugging.

## Boundary

Plasma is the bridge, not the compiler, runtime or framework. Each adapter is independently proven only after real bidirectional execution, error propagation, lifecycle cleanup and data-conversion tests pass.
