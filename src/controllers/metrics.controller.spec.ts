import { MetricsController } from './metrics.controller';
import { InstrumentationService } from '../telemetry/instrumentation.service';

describe('MetricsController', () => {
  let controller: MetricsController;
  let mockInstrumentation: {
    getMetrics: jest.Mock;
    getContentType: jest.Mock;
  };

  beforeEach(() => {
    mockInstrumentation = {
      getMetrics: jest.fn().mockResolvedValue('# HELP http_requests_total\nhttp_requests_total 42'),
      getContentType: jest.fn().mockReturnValue('text/plain; version=0.0.4; charset=utf-8')
    };

    controller = new MetricsController(mockInstrumentation as unknown as InstrumentationService);
  });

  describe('getMetrics', () => {
    it('should return metrics string with correct content type', async () => {
      const mockSet = jest.fn();
      const mockEnd = jest.fn();
      const res = { set: mockSet, end: mockEnd } as any;

      await controller.getMetrics(res);

      expect(mockInstrumentation.getMetrics).toHaveBeenCalledTimes(1);
      expect(mockInstrumentation.getContentType).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      expect(mockEnd).toHaveBeenCalledWith('# HELP http_requests_total\nhttp_requests_total 42');
    });

    it('should call getMetrics before writing response', async () => {
      const callOrder: string[] = [];
      mockInstrumentation.getMetrics.mockImplementation(async () => {
        callOrder.push('getMetrics');
        return 'metrics-data';
      });
      const res = {
        set: jest.fn(() => callOrder.push('set')),
        end: jest.fn(() => callOrder.push('end'))
      } as any;

      await controller.getMetrics(res);

      expect(callOrder).toEqual(['getMetrics', 'set', 'end']);
    });
  });
});
