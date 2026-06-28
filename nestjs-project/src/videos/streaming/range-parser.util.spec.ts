import { parseRangeHeader } from './range-parser.util';
import { StreamRangeInvalidException } from '../../common/exceptions/domain.exception';

describe('parseRangeHeader', () => {
  it('returns null when the header is undefined', () => {
    expect(parseRangeHeader(undefined, 1024)).toBeNull();
  });

  it('returns null when the header is empty', () => {
    expect(parseRangeHeader('', 1024)).toBeNull();
  });

  it('parses "bytes=0-99" to { start: 0, end: 99 }', () => {
    expect(parseRangeHeader('bytes=0-99', 1024)).toEqual({ start: 0, end: 99 });
  });

  it('parses "bytes=100-199" to { start: 100, end: 199 }', () => {
    expect(parseRangeHeader('bytes=100-199', 1024)).toEqual({
      start: 100,
      end: 199,
    });
  });

  it('parses "bytes=0-" (open-ended end) to end = totalSize - 1', () => {
    expect(parseRangeHeader('bytes=0-', 1024)).toEqual({
      start: 0,
      end: 1023,
    });
  });

  it('throws StreamRangeInvalidException on malformed header "bytes=abc-def"', () => {
    expect(() => parseRangeHeader('bytes=abc-def', 1024)).toThrow(
      StreamRangeInvalidException,
    );
  });

  it('throws StreamRangeInvalidException on inverted range "bytes=100-99"', () => {
    expect(() => parseRangeHeader('bytes=100-99', 1024)).toThrow(
      StreamRangeInvalidException,
    );
  });

  it('throws StreamRangeInvalidException when end >= totalSize', () => {
    expect(() => parseRangeHeader('bytes=0-1024', 1024)).toThrow(
      StreamRangeInvalidException,
    );
    expect(() => parseRangeHeader('bytes=0-999999999999', 1024)).toThrow(
      StreamRangeInvalidException,
    );
  });

  it('throws StreamRangeInvalidException on negative values', () => {
    expect(() => parseRangeHeader('bytes=-1-99', 1024)).toThrow(
      StreamRangeInvalidException,
    );
  });

  it('accepts the maximum valid range', () => {
    expect(parseRangeHeader('bytes=0-1023', 1024)).toEqual({
      start: 0,
      end: 1023,
    });
  });
});
