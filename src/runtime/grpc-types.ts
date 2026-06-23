/**
 * TypeScript interfaces for gRPC request/response shapes.
 * Reduces `any` casts in RustRuntimeProvider.
 */

export interface GrpcClientInfo {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
}

export interface GrpcCapabilities {
  sessions?: { stream?: boolean };
  cancellation?: { cancelSession?: boolean };
  progress?: { progress?: boolean };
  manifest?: { getManifest?: boolean };
  modeRegistry?: { listModes?: boolean; listChanged?: boolean };
  roots?: { listRoots?: boolean; listChanged?: boolean };
  experimental?: { features?: Record<string, unknown> };
}

export interface GrpcInitializeRequest {
  supportedProtocolVersions: string[];
  clientInfo: GrpcClientInfo;
  capabilities: GrpcCapabilities;
}

export interface GrpcInitializeResponse {
  selectedProtocolVersion: string;
  runtimeInfo?: GrpcClientInfo;
  supportedModes?: string[];
  capabilities?: GrpcCapabilities;
}

export interface GrpcEnvelope {
  macpVersion: string;
  mode: string;
  messageType: string;
  messageId: string;
  sessionId: string;
  sender: string;
  timestampUnixMs: string;
  payload: Buffer;
}

export interface GrpcAck {
  ok?: boolean;
  duplicate?: boolean;
  messageId?: string;
  sessionId?: string;
  acceptedAtUnixMs?: string;
  sessionState?: string;
  error?: {
    code: string;
    message: string;
    sessionId?: string;
    messageId?: string;
    details?: Buffer;
  };
}

export interface GrpcSendResponse {
  ack: GrpcAck;
}

export interface GrpcStreamChunk {
  envelope: GrpcEnvelope;
}

export interface GrpcSessionMetadata {
  sessionId?: string;
  mode?: string;
  state?: string;
  startedAtUnixMs?: string;
  expiresAtUnixMs?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
}

export interface GrpcGetSessionResponse {
  metadata: GrpcSessionMetadata;
}

export interface GrpcCancelSessionResponse {
  ack: GrpcAck;
}

export interface GrpcSuspendSessionResponse {
  ack: GrpcAck;
}

export interface GrpcResumeSessionResponse {
  ack: GrpcAck;
}

export interface GrpcManifest {
  agentId?: string;
  title?: string;
  description?: string;
  supportedModes?: string[];
  metadata?: Record<string, string>;
}

export interface GrpcGetManifestResponse {
  manifest?: GrpcManifest;
}

export interface GrpcModeDescriptor {
  mode: string;
  modeVersion: string;
  title?: string;
  description?: string;
  determinismClass?: string;
  participantModel?: string;
  messageTypes?: string[];
  terminalMessageTypes?: string[];
  schemaUris?: Record<string, string>;
}

export interface GrpcListModesResponse {
  modes?: GrpcModeDescriptor[];
}

export interface GrpcRootDescriptor {
  uri: string;
  name?: string;
}

export interface GrpcListRootsResponse {
  roots?: GrpcRootDescriptor[];
}
