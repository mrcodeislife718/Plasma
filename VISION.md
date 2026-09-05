# Plasma Vision

## Product identity

Plasma is the Cannon interoperability layer.

Its mission is to prevent Cannon/Cannon+ from becoming isolated from the enormous amount of useful software that already exists in other languages, runtimes, libraries, and operating systems.

## Primary comparison set

Plasma is our answer to lessons drawn from:

- Node-API
- SWIG
- JNI
- Python C API
- conventional FFI/binding systems

It should preserve broad interoperability and ABI access while improving safety, lifecycle clarity, diagnostics, async behavior, and developer experience across boundaries.

## Strengths to preserve

- Stable value and ABI contracts.
- Generated bindings where they reduce repetitive glue code.
- Efficient marshaling and data conversion.
- Explicit ownership/lifecycle handling.
- Async bridging.
- Error translation.
- Source-aware cross-language diagnostics.
- Bidirectional interoperability.
- Broad reach across JavaScript/Node, C, C++, Python, JVM/Java, Ruby, PHP, Perl, WebAssembly, and native OS APIs as support is proven.

## Weaknesses to eliminate

- unreadable/generated glue that developers cannot debug;
- unstable ABI assumptions;
- silent ownership/lifetime mistakes;
- process-wide crashes caused by unsafe boundary behavior where isolation is practical;
- async models that do not compose;
- foreign errors stripped of useful source context;
- pretending a native boundary is safe merely because the calling runtime is sandboxed.

## Independent ceiling

Plasma should become a first-class interoperability product and migration accelerator. It is not merely an internal FFI helper for Parallel or Velocity.

## Ecosystem role

Nova can provide type/semantic information for generated bindings. Parallel provides runtime-side contracts. Velocity uses Plasma for native modules/plugins. Cadence and Sprout may consume foreign/native integrations. Cortex surfaces cross-boundary diagnostics and debugging.

## Architectural invariant

**Plasma remains the interoperability bridge. Its job is to make existing ecosystems safely and productively accessible to Cannon, not to force rewrites, hide unsafe boundaries, or collapse foreign systems into Cannon-native abstractions.**
