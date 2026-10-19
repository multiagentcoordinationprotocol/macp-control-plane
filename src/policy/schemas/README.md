# Vendored policy rule schemas

Byte-for-byte copies of `schemas/json/policy/{decision,quorum,proposal,task,handoff}-rules.schema.json`
from the spec repo `multiagentcoordinationprotocol/multiagentcoordinationprotocol`, at commit
`60262b8` (`60262b8f9ac487784f82a28bb85614cbe2e9f30b`). Used by `PolicyRulesValidatorService` on
`POST /runtime/policies`.

The runtime enforces closed rule objects since v0.9.0 (proposal S1: `^[_$]` annotation keys at every
closed level, top-level `x-` vendor-extension keys only when the runtime implements them). This copy
is a fail-fast pre-check that refuses the same rules before the gRPC round-trip, so it must stay
byte-identical to the spec. There is no automated re-sync: when the spec changes these schemas,
re-copy them and update the hashes below (`policy-rules-validator.service.spec.ts` checks them).

| File | sha256 |
|------|--------|
| `decision-rules.schema.json` | `da877a4ab7859ee6c685964374d94a68347ff5bdab4b4acc359b25eba0b167cb` |
| `handoff-rules.schema.json` | `d53090c690d8daae7a1effd0638dfd6dba2539f68fc2c74dd7946486618d5b3b` |
| `proposal-rules.schema.json` | `ad5f3491e919bdcb361f381bfef4b0f216b0f30ef9c717d4ed24d1e811d15e94` |
| `quorum-rules.schema.json` | `6971df421e215c09167a76a824f794343f353d9192ee7f6f04be646a102bd53d` |
| `task-rules.schema.json` | `61f759faa5d32527776b0221417b9789a1dd0d00c0c7c3e623f501e9de43f3fd` |
