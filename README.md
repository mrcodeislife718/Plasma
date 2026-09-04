# Plasma

Plasma is the Cannon interoperability layer.

Its purpose is to keep Cannon/Cannon+ from becoming isolated from existing software ecosystems. Plasma provides stable contracts for calling into and being called from foreign languages, runtimes, libraries, WebAssembly, and native operating-system APIs.

## Responsibilities

Plasma owns:

- stable value and ABI contracts;
- generated bindings;
- marshaling and data conversion;
- lifecycle and ownership control across boundaries;
- async bridging;
- error translation;
- source-aware diagnostics.

Initial targets include JavaScript/Node, C, C++, Python, JVM/Java, Ruby, PHP, Perl, WebAssembly, and native OS APIs.

## Role in the Cannon developer ecosystem

```text
Cannon / Cannon+
       │
       ▼
      Nova
       │
       ▼
     Plasma
       │
       ├── JavaScript / Node
       ├── C / C++
       ├── Python
       ├── JVM / Java
       ├── Ruby / PHP / Perl
       ├── WebAssembly
       └── native OS APIs
```

Parallel exposes runtime-side contracts, Velocity uses Plasma for native modules/plugins, and Cortex surfaces cross-boundary diagnostics and debugging.

## Proof standard

An adapter is supported only after real Cannon→foreign and foreign→Cannon execution tests pass, including error propagation, lifecycle/resource cleanup, and representative data conversion.

## Commercial boundary

Core adapters can drive adoption. Revenue can come from certified enterprise bindings, proprietary SDK generation, legacy modernization, ABI guarantees, private adapters, support, and compliance validation.

See [ECOSYSTEM.md](./ECOSYSTEM.md) and [ROADMAP.md](./ROADMAP.md).
