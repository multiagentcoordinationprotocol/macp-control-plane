import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DecisionReceiptService } from '../receipts/decision-receipt.service';

/** Media type of a JWK Set (RFC 7517 §8.5.1). */
export const JWK_SET_MEDIA_TYPE = 'application/jwk-set+json';

@Controller()
export class DecisionReceiptController {
  constructor(private readonly receipts: DecisionReceiptService) {}

  @Get('runs/:id/receipt')
  @ApiTags('runs')
  @ApiOperation({
    summary: "The run's runtime-issued decision receipt (RFC-MACP-0013 §13).",
    description:
      "`{runId, sessionId, receiptJson, receipt}`: `receiptJson` is the runtime's `macp-receipt/1` text " +
      'verbatim (verify over it, never over a re-serialization of `receipt`). Verify the `jws` ' +
      'attestations against `GET /runtime/receipt-keys`. 501 DECISION_RECEIPT_UNSUPPORTED when the runtime ' +
      'predates 0.11; 409 RECEIPT_UNAVAILABLE when the session is not RESOLVED by a Commitment; 404 ' +
      'RUN_NOT_FOUND / NOT_FOUND (no session yet, or the runtime does not know it).'
  })
  async getReceipt(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.receipts.getReceipt(id);
  }

  @Get('runtime/receipt-keys')
  @ApiTags('runtime')
  @ApiProduces(JWK_SET_MEDIA_TYPE)
  @ApiOperation({
    summary: "The runtime's receipt verification keys, a JWK Set (RFC-MACP-0013 §13 item 8).",
    description:
      'The runtime\'s `GetReceiptKeys` JSON verbatim, as `application/jwk-set+json`; `{"keys":[]}` when it ' +
      'has none. Cacheable for a short TTL (`Cache-Control: private, max-age=<=60`). 501 ' +
      'DECISION_RECEIPT_UNSUPPORTED when the runtime predates 0.11.'
  })
  async getReceiptKeys(@Res({ passthrough: true }) res: Response): Promise<string> {
    const { jwksJson, maxAgeSeconds } = await this.receipts.getReceiptKeys();
    res.setHeader('Content-Type', `${JWK_SET_MEDIA_TYPE}; charset=utf-8`);
    res.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
    return jwksJson;
  }
}
