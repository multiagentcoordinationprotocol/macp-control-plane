import { VerificationController } from './verification.controller';
import { CommitmentVerificationService } from '../verification/commitment-verification.service';

describe('VerificationController', () => {
  it('GET /runs/:id/verification delegates to the verification service', async () => {
    const verify = jest.fn().mockResolvedValue({ runId: 'r1', status: 'verified' });
    const controller = new VerificationController({ verify } as unknown as CommitmentVerificationService);
    await expect(controller.getVerification('r1')).resolves.toEqual({ runId: 'r1', status: 'verified' });
    expect(verify).toHaveBeenCalledWith('r1');
  });
});
