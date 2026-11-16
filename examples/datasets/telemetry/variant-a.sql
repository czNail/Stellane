-- Hypothesis A: event 2 was emitted by device-a (North).
-- Run on a branch of the drifted baseline. This is a proposed rule, not a discovered truth.
UPDATE stellane_demo_telemetry.event_log
SET device_hint='device-a'
WHERE event_no=2;
