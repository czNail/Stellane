-- Hypothesis B: event 2 was emitted by device-c (South).
-- Both alternatives repair coverage. Business evidence must decide the correct mapping.
UPDATE stellane_demo_telemetry.event_log
SET device_hint='device-c'
WHERE event_no=2;
