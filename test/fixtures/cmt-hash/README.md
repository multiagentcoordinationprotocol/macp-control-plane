# RFC-MACP-0013 commitment-hash vectors

Verbatim copies of `schemas/conformance/cmt-hash/cmt_hash_0*.json` from the spec repo
(`multiagentcoordinationprotocol`, copied at commit `59ae57d`). Do not hand-edit: when the spec
adds or changes a vector, copy the files again. `src/verification/commitment-hash-vectors.spec.ts`
runs every vector here and fails if the set shrinks below the ten RFC-MACP-0013 §11 names.
