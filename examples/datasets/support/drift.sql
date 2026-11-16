-- Simulate an increased estimate and an intake routing change.
-- Only ticket 2 breaks the saved relationship; ticket 1 changes the workload total.
UPDATE stellane_demo_support.ticket_log
SET estimated_minutes=CASE WHEN ticket_no=1 THEN 240 ELSE estimated_minutes END,
    queue_hint=CASE WHEN ticket_no=2 THEN 'unrouted' ELSE queue_hint END
WHERE ticket_no IN (1,2);
