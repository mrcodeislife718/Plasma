# Plasma Roadmap

Plasma is the Cannon interoperability layer.

## Product contract

Plasma connects Cannon/Cannon+ to foreign ecosystems through stable boundary contracts, generated bindings, marshaling, lifecycle control, async bridging, error translation, and source-aware diagnostics.

## Initial language targets

JavaScript/Node, C, C++, Python, JVM/Java, Ruby, PHP, Perl, WebAssembly, and native operating-system APIs. Support is claimed per adapter only after real bidirectional execution tests pass.

## Design sources

Plasma takes Node-API's ABI-stability lesson, SWIG's multi-language reach, JNI's mature native access, and the Python C API's performance while avoiding unsafe process-wide crashes, unreadable generated wrappers, and unstable binding contracts.

## Implementation order

1. Stable Plasma value/ABI model.
2. JavaScript/Node adapter.
3. C ABI adapter.
4. C++ wrapper generator.
5. Python adapter.
6. JVM adapter.
7. Ruby/PHP/Perl adapters.
8. WASM adapter.
9. Cross-boundary async, ownership, and provenance diagnostics.

## Proof gates

Each adapter requires Cannon→foreign and foreign→Cannon execution tests, error propagation, lifecycle/resource cleanup, and representative data conversion tests.

## Commercial boundary

Plasma core adapters can drive adoption. Revenue can come from certified enterprise bindings, proprietary SDK generation, legacy modernization, ABI guarantees, private adapters, support, and compliance validation.
