/* eslint-disable @typescript-eslint/no-explicit-any */

import type { vi } from 'vitest';

declare global {
  const jest: typeof vi;

  namespace jest {
    interface Mock {
      (...args: any[]): any;
      mock: {
        calls: any[][];
      };
      mockClear(): this;
      mockImplementation(fn: (...args: any[]) => any): this;
      mockImplementationOnce(fn: (...args: any[]) => any): this;
      mockRejectedValue(value: any): this;
      mockRejectedValueOnce(value: any): this;
      mockResolvedValue(value: any): this;
      mockResolvedValueOnce(value: any): this;
      mockReturnValue(value: any): this;
      mockReturnValueOnce(value: any): this;
    }
  }
}

export {};
