import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommitmentVerificationService } from '../verification/commitment-verification.service';

@ApiTags('runs')
@Controller('runs')
export class VerificationController {
  constructor(private readonly verification: CommitmentVerificationService) {}

  @Get(':id/verification')
  @ApiOperation({
    summary: "Recompute the RFC-MACP-0013 commitment hash of the run's Commitment and cross-check it.",
    description:
      'Read-only. Hashes the stored CommitmentPayload and the raw envelope payload bytes, runs the ' +
      'RFC-MACP-0013 §6.1 verifier on the bytes, and checks the projected decision matches. ' +
      '`status` is `pending` until the run has a Commitment.'
  })
  async getVerification(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.verification.verify(id);
  }
}
