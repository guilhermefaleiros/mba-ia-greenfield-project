---
subproject: backend
runner: nestjs+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos/stream-download.e2e-spec.ts
---

# Video Stream & Download Test Plan

## Application Overview

Two read-side HTTP endpoints of the `videos` module for playback and download:

- `GET /videos/{videoId}/stream` — proxies a byte range from MinIO back to the client. Honors the `Range` header and returns `206 Partial Content` with `Content-Range`/`Accept-Ranges: bytes`. The endpoint is **anonymous in Phase 03** (Phase 04's `unlisted` visibility will add a per-video authorization check).
- `GET /videos/{videoId}/download` — returns the full source object with `Content-Disposition: attachment; filename="{videoId}.mp4"`. Requires JWT.

Both endpoints reject with `409 VIDEO_NOT_READY` if the video's status is not `pronto`, and `404 VIDEO_NOT_FOUND` if the row does not exist. Invalid `Range` headers (malformed, inverted, or out-of-bounds) return `416 STREAM_RANGE_INVALID`.

## Test Scenarios

### 1. Stream & download flow

**Setup:** Truncate `videos` table. Bootstrap the Nest test module (same as `videos-upload.plan.md` Setup). Seed:

- A test channel `ch1` owned by `user1` (with valid JWT).
- A test video `v_pronto` in `ch1` with status `pronto`, `source_key` = `videos/ch1.id/v_pronto.id/source.mp4`, and a real ~2MB MP4 buffer pre-uploaded to MinIO under that key (so byte-range assertions have non-zero content).
- A test video `v_draft` in `ch1` with status `aguardando_upload` (for the not-ready 409 assertion).

#### 1.1. stream happy 206 (Range)

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. GET /videos/<v_pronto.id>/stream com header `Range: bytes=0-1048575`
    - expect: status 206
    - expect: header `Content-Range: bytes 0-1048575/<total>` (onde `<total>` é o tamanho do object no MinIO, ~2*1024*1024 = 2097152)
    - expect: header `Accept-Ranges: bytes`
    - expect: header `Content-Length: 1048576`
    - expect: header `Content-Type: video/mp4`
    - expect: body tem 1048576 bytes; o SHA-256 do body bate com o SHA-256 do range correspondente do source object (calcular o range `bytes 0-1048575` do source via SDK e comparar).

#### 1.2. stream error paths (invalid range, not-ready, not-found)

**Covers AC:** #2, #3, #4, #5
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. GET /videos/<v_pronto.id>/stream com header `Range: bytes=100-99` (inverted)
    - expect: status 416
    - expect: body `error: "STREAM_RANGE_INVALID"`
  2. GET /videos/<v_pronto.id>/stream com header `Range: bytes=0-999999999999` (out of bounds)
    - expect: status 416 (MinIO devolve 416 nativamente; o service layer repassa sem reescrever)
  3. GET /videos/<v_pronto.id>/stream com header `Range: bytes=abc-def` (malformed)
    - expect: status 416
    - expect: body `error: "STREAM_RANGE_INVALID"` (parseRangeHeader lança DomainException antes de chamar o MinIO)
  4. GET /videos/<v_draft.id>/stream (qualquer Range, ou sem Range)
    - expect: status 409
    - expect: body `error: "VIDEO_NOT_READY"`
  5. GET /videos/nonexistent-id/stream
    - expect: status 404
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 1.3. download happy + 401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. GET /videos/<v_pronto.id>/download sem header `Authorization`
    - expect: status 401
    - expect: body `error: "UNAUTHENTICATED"`
  2. GET /videos/nonexistent/download com `Authorization: Bearer <user1 jwt>`
    - expect: status 404
    - expect: body `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/<v_draft.id>/download com `Authorization: Bearer <user1 jwt>`
    - expect: status 409
    - expect: body `error: "VIDEO_NOT_READY"`
  4. GET /videos/<v_pronto.id>/download com `Authorization: Bearer <user1 jwt>`
    - expect: status 200
    - expect: header `Content-Type: video/mp4`
    - expect: header `Content-Disposition: attachment; filename="<v_pronto.id>.mp4"`
    - expect: header `Content-Length: <total>` (igual ao `ContentLength` retornado por S3 `HeadObject`)
    - expect: body byte-identical ao source object (SHA-256 match)
