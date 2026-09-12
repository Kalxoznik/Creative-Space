# Creative Wizards Kanban

HTML/CSS layout of the **Creative Wizards** project tracker from Figma — sidebar, top bar, 3-column kanban board, task detail panel, and Create task modal.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- Inter font
- Local SVG icons exported from Figma

## Run locally

```bash
npm install
npm run dev -- --port 43123
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

## Features

- Fixed 220px sidebar with navigation and boards
- Top bar: breadcrumb, search, Filters / Power-ups / Automation, `+ Create`
- Kanban columns: Backlog, Design, To Do with card counts and fade
- Selected **Security Review** card with detail panel (members, files, task chat)
- Create task modal overlay (blur backdrop, Task/Board switcher)

## Design tokens

| Token | Value |
| --- | --- |
| Accent | `#E8AB24` |
| Background | `#F6F6F5` |
| Text | `#292826` / `#706E69` / `#A4A19A` |
| Borders | `#E4E2DE` |
