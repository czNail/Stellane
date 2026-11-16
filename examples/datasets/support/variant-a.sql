-- Policy A: route the unassigned ticket to General.
-- Its queue then needs 390 minutes against a synthetic capacity of 300.
UPDATE stellane_demo_support.ticket_log
SET queue_hint='general'
WHERE ticket_no=2;
