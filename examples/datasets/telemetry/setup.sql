-- Synthetic data only. This script deliberately fails if the demo schema exists.
-- There are no foreign keys: the Agent must investigate and verify the joins.
CREATE SCHEMA stellane_demo_telemetry;
COMMENT ON SCHEMA stellane_demo_telemetry IS 'Stellane synthetic telemetry demo. Safe to replace only in an explicitly selected demo database.';
CREATE TABLE stellane_demo_telemetry.zone_registry (
  zone_key text NOT NULL,
  area text NOT NULL
);
CREATE TABLE stellane_demo_telemetry.device_inventory (
  device_token text NOT NULL,
  zone_ref text NOT NULL
);
CREATE TABLE stellane_demo_telemetry.event_log (
  event_no integer NOT NULL,
  device_hint text NOT NULL,
  magnitude integer NOT NULL,
  state text NOT NULL
);
COMMENT ON TABLE stellane_demo_telemetry.zone_registry IS 'One row per operational zone. zone_key identifies its area.';
COMMENT ON TABLE stellane_demo_telemetry.device_inventory IS 'One row per device. device_token is emitted with events; zone_ref identifies its zone.';
COMMENT ON TABLE stellane_demo_telemetry.event_log IS 'One row per event. Only active events count in the demo metric; magnitude uses generic measurement units.';
COMMENT ON COLUMN stellane_demo_telemetry.event_log.device_hint IS 'Token supplied by the emitting device; its meaning must be checked against the inventory.';
COMMENT ON COLUMN stellane_demo_telemetry.event_log.magnitude IS 'Generic measurement units, not money and not a claim about a physical unit.';
INSERT INTO stellane_demo_telemetry.zone_registry VALUES ('zone-n','North'),('zone-s','South');
INSERT INTO stellane_demo_telemetry.device_inventory VALUES ('device-a','zone-n'),('device-b','zone-n'),('device-c','zone-s');
INSERT INTO stellane_demo_telemetry.event_log VALUES
  (1,'device-a',10,'active'),
  (2,'device-a',20,'active'),
  (3,'device-b',30,'active'),
  (4,'device-c',40,'active'),
  (5,'device-b',50,'active'),
  (6,'device-c',60,'inactive');
CREATE VIEW stellane_demo_telemetry.active_event_totals AS
  SELECT z.area, count(*) AS event_count, sum(e.magnitude) AS units
  FROM stellane_demo_telemetry.event_log e
  JOIN stellane_demo_telemetry.device_inventory d ON e.device_hint=d.device_token
  JOIN stellane_demo_telemetry.zone_registry z ON d.zone_ref=z.zone_key
  WHERE e.state='active' GROUP BY z.area;
COMMENT ON VIEW stellane_demo_telemetry.active_event_totals IS 'Legacy inner-join report. It omits events without a matching device or zone; compare with the full event population.';
