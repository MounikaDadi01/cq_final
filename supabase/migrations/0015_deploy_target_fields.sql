-- 0015 · the tool's own required fields
--
-- The first real deploy reached the create form and stopped, correctly: Adstream
-- requires an existing campaign and an objective, and nothing in our model supplied
-- either. That was a modelling gap, not an agent failure — we had assumed a tool would
-- accept our campaign name as free text, and a real one has its own taxonomy.
--
-- The agent must not invent these. A made-up campaign attaches an ad to the wrong
-- budget, and that is the kind of mistake somebody finds in a billing report.

alter table deployments
  add column if not exists target_campaign text,
  add column if not exists target_objective text,
  add column if not exists target_notes text;

comment on column deployments.target_campaign is
  'The campaign inside the marketing tool to attach to, chosen by a person from what '
  'the tool offers. Null means the agent must stop rather than guess.';
