export const CSV_FIELDS = ['session_id', 'source_type', 'frame_index', 'timestamp_ms', 'recorded_at', 'people_count', 'tracked_count', 'peak_count', 'unique_track_count', 'processing_ms'];
export function countsCsv(records) {
  return '\ufeff' + [CSV_FIELDS.join(','), ...records.map(record => CSV_FIELDS.map(key => String(record[key] ?? '')).join(','))].join('\r\n') + '\r\n';
}
export function recordsJsonl(records) { return records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''); }
export function summary(run) {
  return { schema_version: '2.0-browser', id: run.id, name: run.name, source_type: run.source_type,
    status: run.status, created_at: run.created_at, finished_at: run.finished_at, provider: run.provider,
    confidence: run.confidence, target_fps: run.target_fps, processed_frames: run.records.length,
    peak_count: run.latest?.peak_count || 0, latest: run.latest || null,
    source_duration_ms: run.duration_ms || null, video_partial: !!run.video_partial,
    timeline: run.timeline, storage: 'tab-memory-only', frames_uploaded: false,
    sampling_note: 'Only processed samples are exported; device speed can reduce the selected frequency.' };
}

