export * from './types';
export { generatePairingCode } from './crypto';
export { CompanionClient } from './client';
export {
  COMPANION_FRAME_MAGIC,
  CompanionProtocolError,
  decodeCompanionFrame,
  encodeCompanionFrame,
  MAX_COMPANION_DEPTH_BYTES,
  MAX_COMPANION_JSON_BYTES,
  supportsCompanionGzip,
} from './codec';
export { CompanionSampleDecoder, fullSpatialUpdate, type CompanionDepthUpdate, type CompanionPoseDelta, type CompanionSpatialUpdate, type WirePose } from './sample';
export { PairingSession, type CompanionSessionEvent, type PairingSessionOptions, type PairingSessionState } from './session';
export { assertTrustedLocalWssUrl, createWebSocketTransport, WebSocketTransport } from './transport';
export {
  acceptPairingJoin,
  createPairingJoin,
  createPairingMaterial,
  exportHostOffer,
  verifyPairingCode,
  type AcceptedPairing,
  type PairingJoinPayload,
  type PairingMaterial,
  type PairingOfferPayload,
} from './pairing';
