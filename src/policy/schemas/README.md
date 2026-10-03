# Vendored policy rule schemas

Byte-for-byte copies of `schemas/json/policy/{decision,quorum,proposal,task,handoff}-rules.schema.json`
from the spec repo `multiagentcoordinationprotocol/multiagentcoordinationprotocol`, at commit
`7159afe`. Used by `PolicyRulesValidatorService` to reject unknown keys / bad shapes on
`POST /runtime/policies` (the runtime itself does not enforce closed-set rules — macp-runtime #167,
"out of scope by design"). There is no automated re-sync: diff against the spec repo when it changes
these schemas.
