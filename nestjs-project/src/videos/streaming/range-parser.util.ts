import { StreamRangeInvalidException } from '../../common/exceptions/domain.exception';

const RANGE_REGEX = /^bytes=(\d*)-(\d*)$/;

export interface ParsedRange {
  start: number;
  end: number;
}

export function parseRangeHeader(
  header: string | undefined,
  totalSize: number,
): ParsedRange | null {
  if (header === undefined || header === null || header === '') {
    return null;
  }
  const match = RANGE_REGEX.exec(header);
  if (!match) {
    throw new StreamRangeInvalidException('Range header is malformed');
  }

  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';
  const start = startStr === '' ? 0 : parseInt(startStr, 10);
  const end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new StreamRangeInvalidException(
      'Range header has non-numeric values',
    );
  }
  if (start < 0 || end < 0) {
    throw new StreamRangeInvalidException('Range header has negative values');
  }
  if (start > end) {
    throw new StreamRangeInvalidException('Range start is greater than end');
  }
  if (end >= totalSize) {
    throw new StreamRangeInvalidException('Range end is out of bounds');
  }

  return { start, end };
}
