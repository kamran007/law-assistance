/** RFC 9457 problem details (TRD §5). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
}

export const problem = (status: number, code: string, title: string, detail?: string): Problem => ({
  type: `https://lawassist.bd/errors/${code.toLowerCase().replace(/_/g, '-')}`,
  title,
  status,
  code,
  ...(detail ? { detail } : {}),
});

/**
 * An expected 4xx outcome that a route throws; the error handler turns it into a problem response.
 * `title` and `detail` reach the client, so they must never contain document text or user input
 * beyond what the client sent.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = 'ApiError';
  }

  toProblem(): Problem {
    return problem(this.status, this.code, this.title, this.detail);
  }
}
