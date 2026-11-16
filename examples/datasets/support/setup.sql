-- Synthetic workload planning data. Deliberately fails if the demo schema exists.
-- No foreign key or industry-specific Stellane logic is involved.
CREATE SCHEMA stellane_demo_support;
COMMENT ON SCHEMA stellane_demo_support IS 'Stellane synthetic support workload demo. Safe to replace only in an explicitly selected demo database.';
CREATE TABLE stellane_demo_support.service_queues (
  queue_key text NOT NULL,
  team_name text NOT NULL,
  capacity_minutes integer NOT NULL
);
CREATE TABLE stellane_demo_support.ticket_log (
  ticket_no integer NOT NULL,
  queue_hint text NOT NULL,
  estimated_minutes integer NOT NULL,
  priority text NOT NULL,
  state text NOT NULL
);
COMMENT ON TABLE stellane_demo_support.service_queues IS 'One row per team queue. capacity_minutes is the available capacity for this toy planning window, not an SLA.';
COMMENT ON TABLE stellane_demo_support.ticket_log IS 'One row per ticket. Open tickets consume estimated_minutes in this toy planning window; closed tickets are excluded.';
COMMENT ON COLUMN stellane_demo_support.ticket_log.queue_hint IS 'Routing tag issued by intake. Check its correspondence to service_queues.queue_key before grouping tickets.';
COMMENT ON COLUMN stellane_demo_support.ticket_log.estimated_minutes IS 'Synthetic effort estimate in minutes. It is additive for planning, not measured handling time or a prediction of customer waiting time.';
INSERT INTO stellane_demo_support.service_queues VALUES ('general','General',300),('specialist','Specialist',480);
INSERT INTO stellane_demo_support.ticket_log VALUES
  (1,'general',120,'urgent','open'),
  (2,'general',90,'urgent','open'),
  (3,'general',60,'normal','open'),
  (4,'specialist',100,'normal','open'),
  (5,'specialist',80,'urgent','open'),
  (6,'specialist',20,'normal','open'),
  (7,'general',50,'normal','closed');
CREATE VIEW stellane_demo_support.open_queue_load AS
  SELECT q.team_name, count(*) AS open_tickets, sum(t.estimated_minutes) AS planned_minutes,
    q.capacity_minutes
  FROM stellane_demo_support.ticket_log t
  JOIN stellane_demo_support.service_queues q ON t.queue_hint=q.queue_key
  WHERE t.state='open' GROUP BY q.team_name,q.capacity_minutes;
COMMENT ON VIEW stellane_demo_support.open_queue_load IS 'Legacy inner-join report. Unrouted tickets are omitted, so reconcile against all open tickets before comparing capacity.';
