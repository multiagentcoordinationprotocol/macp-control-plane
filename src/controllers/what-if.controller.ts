import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WhatIfReplayRequestDto } from '../dto/what-if-replay.dto';
import { WhatIfReplayService } from '../what-if/what-if-replay.service';

@ApiTags('runs')
@Controller('runs')
export class WhatIfController {
  constructor(private readonly whatIf: WhatIfReplayService) {}

  @Post(':id/what-if')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replay the run's session under a candidate policy (RFC-MACP-0012 §8.1).",
    description:
      'Read-only: the candidate is admission-checked but never registered, and nothing is persisted. ' +
      'Returns the recorded and candidate outcomes, per-entry results and the first divergence. ' +
      '501 WHAT_IF_REPLAY_UNSUPPORTED when the runtime predates 0.10; 409 HISTORY_UNAVAILABLE when ' +
      "the runtime compacted the ended session's log."
  })
  async replay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: WhatIfReplayRequestDto
  ) {
    return this.whatIf.replay(id, body.candidate);
  }
}
