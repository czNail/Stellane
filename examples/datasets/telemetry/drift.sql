-- Simulate an external producer changing one event's device token.
-- Re-running this change has the same effect. The original metric total stays 150.
UPDATE stellane_demo_telemetry.event_log
SET device_hint='missing-device'
WHERE event_no=2;
