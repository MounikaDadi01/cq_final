1. Generate an ad from a brain
Resolve the brand, generate a plate, overlay the copy, render the canvas. SKILL.md has the contract: plate-first, one plate per canvas size, every word live in HTML, logos at their real proportions.
That contract is necessary and it isn’t sufficient. An ad whose copy is the same colour as the plate behind it satisfies every rule in SKILL.md and is worth nothing. The model can read images. Have it look at what it made before anything calls itself done.
Do it for both brands. A pipeline that only works for Kahua isn’t a pipeline.
Plate generation is an image model call. We use gpt-image-2 through the OpenAI images API.
These sizes have to work: 1080x1080, 1200x628, 1080x1350, 728x90. If your sizing logic can’t produce one of them, that’s a finding — say so, rather than letting the request fail at run time.

Request intake. Choosing an inspiration is its own step, and the composer treats Brand Kit, Brain, Templates and Past work as four separate things.
