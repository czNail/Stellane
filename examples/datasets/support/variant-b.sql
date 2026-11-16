-- Policy B: route the unassigned ticket to Specialist.
-- General then needs 300/300 minutes, Specialist 290/480; total work stays 590.
UPDATE stellane_demo_support.ticket_log
SET queue_hint='specialist'
WHERE ticket_no=2;
