export type Priority = "NEW" | "LOW" | "MEDIUM" | "HIGH"

export type AvatarTone = "amber" | "blue" | "green" | "purple"

export type Assignee = {
  initials: string
  tone: AvatarTone
}

export type TaskCard = {
  id: string
  title: string
  description: string
  priority: Priority
  comments?: number
  attachments?: number
  assignees: Assignee[]
  selected?: boolean
}

export type Column = {
  id: string
  title: string
  cards: TaskCard[]
}

export type ChatMessage = {
  id: string
  initials: string
  tone: AvatarTone
  text: string
  meta: string
}

export type TaskDetail = {
  title: string
  description: string
  priority: Priority
  members: Array<{ initials: string; tone: AvatarTone; name: string }>
  messages: Array<{
    initials: string
    tone: AvatarTone
    text: string
    meta: string
  }>
}

export type BoardDefinition = {
  id: string
  name: string
  icon: string
  columns: Column[]
  defaultSelectedId: string | null
  detailCardId: string | null
  detail: TaskDetail | null
}

export const AVATAR_STYLES: Record<AvatarTone, { bg: string; text: string }> = {
  amber: { bg: "#fff3da", text: "#f2a000" },
  blue: { bg: "#e8f2ff", text: "#2176dd" },
  green: { bg: "#ddf9e9", text: "#48c77c" },
  purple: { bg: "#f1eaff", text: "#7546e8" },
}

export const PRIORITY_STYLES: Record<Priority, { bg: string; text: string }> = {
  NEW: { bg: "#ddf9e9", text: "#48c77c" },
  LOW: { bg: "#e8f2ff", text: "#2176dd" },
  MEDIUM: { bg: "#fff3da", text: "#f2a000" },
  HIGH: { bg: "#f1eaff", text: "#7546e8" },
}

const emMs: Assignee[] = [
  { initials: "EM", tone: "blue" },
  { initials: "MS", tone: "amber" },
]

const jkEm: Assignee[] = [
  { initials: "JK", tone: "purple" },
  { initials: "EM", tone: "blue" },
]

const msJk: Assignee[] = [
  { initials: "MS", tone: "amber" },
  { initials: "JK", tone: "purple" },
]

export const WEBSITE_DESIGN_COLUMNS: Column[] = [
  {
    id: "backlog",
    title: "Backlog",
    cards: [
      {
        id: "image-optimization",
        title: "Image Optimization",
        description:
          "Optimize images for web use to improve page load times and overall performance.",
        priority: "NEW",
        assignees: emMs,
      },
      {
        id: "seo-metadata",
        title: "SEO Metadata Implementation",
        description:
          "Optimize page titles, meta descriptions, and image alt texts for improved search visibility.",
        priority: "MEDIUM",
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "feedback-form",
        title: "Feedback Form Implementation",
        description:
          "Integrate user feedback forms on key pages to gather insights and improve the overall user experience.",
        priority: "MEDIUM",
        comments: 2,
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "404-page",
        title: "404 Page Design",
        description:
          "Create a custom and user-friendly 404 error page with helpful information and links.",
        priority: "LOW",
        assignees: emMs,
      },
      {
        id: "loading-animation",
        title: "Loading Animation Design",
        description:
          "Design a creative loading animation to keep users engaged while content is loading.",
        priority: "NEW",
        attachments: 3,
        assignees: emMs,
      },
    ],
  },
  {
    id: "design",
    title: "Design",
    cards: [
      {
        id: "interactive-elements",
        title: "Interactive Element Integration",
        description:
          "Incorporate interactive elements like sliders, accordions, or pop-ups to enhance user experience.",
        priority: "MEDIUM",
        comments: 2,
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "nav-menu",
        title: "Navigation Menu Optimization",
        description:
          "Review and optimize the navigation menu for clarity and ease of use.",
        priority: "LOW",
        comments: 2,
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "security-review",
        title: "Security Review",
        description:
          "Conduct a security review to identify and address potential vulnerabilities.",
        priority: "HIGH",
        comments: 2,
        attachments: 1,
        assignees: emMs,
        selected: true,
      },
      {
        id: "ab-testing",
        title: "A/B Testing Setup",
        description:
          "Set up A/B tests for key website elements to analyze user preferences.",
        priority: "HIGH",
        assignees: emMs,
      },
      {
        id: "client-training",
        title: "Client Training Documentation",
        description:
          "Prepare documentation or training materials for the client.",
        priority: "LOW",
        comments: 2,
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "client-training-2",
        title: "Client Training Documentation",
        description:
          "Prepare documentation or training materials for the client.",
        priority: "LOW",
        comments: 2,
        attachments: 1,
        assignees: emMs,
      },
    ],
  },
  {
    id: "todo",
    title: "To Do",
    cards: [
      {
        id: "typography",
        title: "Typography Selection",
        description:
          "Choose appropriate fonts for headings, subheadings, and body text.",
        priority: "MEDIUM",
        assignees: emMs,
      },
      {
        id: "responsive-testing",
        title: "Responsive Design Testing",
        description:
          "Ensure the website design is responsive on various devices and screen sizes.",
        priority: "HIGH",
        assignees: emMs,
      },
      {
        id: "homepage-wireframe",
        title: "Homepage Wireframe Creation",
        description:
          "Develop a wireframe for the homepage outlining the layout and key elements.",
        priority: "HIGH",
        assignees: emMs,
      },
      {
        id: "persona-review",
        title: "User Persona Review",
        description:
          "Evaluate the website design against user personas to ensure alignment.",
        priority: "LOW",
        assignees: emMs,
      },
      {
        id: "social-media",
        title: "Social Media Integration",
        description:
          "Integrate social media elements seamlessly into the design.",
        priority: "MEDIUM",
        assignees: emMs,
      },
    ],
  },
]

/** @deprecated Prefer WEBSITE_DESIGN_COLUMNS / BOARDS */
export const COLUMNS = WEBSITE_DESIGN_COLUMNS

export const MATCH_3_COLUMNS: Column[] = [
  {
    id: "backlog",
    title: "Backlog",
    cards: [
      {
        id: "m3-booster-shop",
        title: "Booster Shop Layout",
        description:
          "Design the in-level shop sheet for hammers, bombs, and color bombs with clear pricing.",
        priority: "NEW",
        assignees: jkEm,
      },
      {
        id: "m3-daily-reward",
        title: "Daily Reward Calendar",
        description:
          "Sketch a seven-day streak calendar that highlights today's chest and tomorrow's tease.",
        priority: "MEDIUM",
        attachments: 2,
        assignees: emMs,
      },
      {
        id: "m3-fail-screen",
        title: "Level Fail Screen",
        description:
          "Create a retry screen that shows remaining lives, a soft CTA to buy more, and a quit path.",
        priority: "MEDIUM",
        comments: 1,
        assignees: msJk,
      },
      {
        id: "m3-tile-set",
        title: "Candy Tile Set Pass",
        description:
          "Refine gem silhouettes so red, blue, green, yellow, and purple read clearly at 64px.",
        priority: "LOW",
        assignees: emMs,
      },
    ],
  },
  {
    id: "design",
    title: "Design",
    cards: [
      {
        id: "m3-hud",
        title: "Match HUD Polish",
        description:
          "Tighten the top bar for moves left, score, and objectives without crowding the board.",
        priority: "HIGH",
        comments: 3,
        attachments: 1,
        assignees: jkEm,
      },
      {
        id: "m3-combo-fx",
        title: "Combo Cascade FX",
        description:
          "Storyboard spark trails and score popups for 3-, 4-, and 5-match cascades.",
        priority: "MEDIUM",
        comments: 2,
        attachments: 4,
        assignees: emMs,
      },
      {
        id: "m3-map-nodes",
        title: "World Map Nodes",
        description:
          "Design locked, current, and completed level pins for the island progression map.",
        priority: "HIGH",
        comments: 1,
        attachments: 2,
        assignees: msJk,
      },
      {
        id: "m3-settings",
        title: "Settings Overlay",
        description:
          "Layout music, SFX, haptics, and help toggles in a modal that fits phone and tablet.",
        priority: "LOW",
        assignees: emMs,
      },
    ],
  },
  {
    id: "todo",
    title: "To Do",
    cards: [
      {
        id: "m3-tutorial",
        title: "First Match Tutorial",
        description:
          "Build a three-step coach mark that teaches swapping adjacent tiles on level 1.",
        priority: "HIGH",
        assignees: jkEm,
      },
      {
        id: "m3-win-celebration",
        title: "Win Celebration Screen",
        description:
          "Animate star fill, coin burst, and continue button after clearing the objective.",
        priority: "MEDIUM",
        attachments: 1,
        assignees: emMs,
      },
      {
        id: "m3-lives-timer",
        title: "Lives Regen Timer",
        description:
          "Show countdown to the next free life and a clear path to refill instantly.",
        priority: "MEDIUM",
        comments: 2,
        assignees: msJk,
      },
      {
        id: "m3-accessibility",
        title: "Colorblind Tile Modes",
        description:
          "Add shape overlays so colorblind players can tell tile types apart on the board.",
        priority: "HIGH",
        assignees: emMs,
      },
    ],
  },
]

export const SECURITY_REVIEW_DETAIL: TaskDetail = {
  title: "Security Review",
  description:
    "Conduct a comprehensive security review to safeguard the website against potential threats and vulnerabilities. This involves a thorough examination of the website’s architecture, codebase, and server configuration to identify and address security risks.",
  priority: "HIGH",
  members: [
    { initials: "MS", tone: "amber", name: "May Sh" },
    { initials: "EM", tone: "blue", name: "Emily Mitchell" },
    { initials: "JK", tone: "purple", name: "Jordan Kim" },
  ],
  messages: [
    {
      initials: "MS",
      tone: "amber",
      text: "Security Review is complete. I confirmed CSP, HSTS, and the barrier logic.",
      meta: "May Sh · 09:12",
    },
    {
      initials: "EM",
      tone: "blue",
      text: "Thanks, May. Can you also confirm whether Ready-Allow should report high per unit before the barrier is considered cleared?",
      meta: "Emily Mitchell · 09:18",
    },
    {
      initials: "MS",
      tone: "amber",
      text: "Yes - Ready-Allow should report high per unit before the barrier is cleared. I'll tighten the wording so it reads as a prerequisite.",
      meta: "May Sh · 09:22",
    },
    {
      initials: "EM",
      tone: "blue",
      text: "Great. Please also confirm whether the plan clock should start after the barrier clears.",
      meta: "Emily Mitchell · 09:26",
    },
  ],
}

export const MATCH_HUD_DETAIL: TaskDetail = {
  title: "Match HUD Polish",
  description:
    "Tighten the top bar so moves, score, and level goals stay readable during fast cascades. Keep touch targets clear of the playfield and preserve space for booster shortcuts on the side rails.",
  priority: "HIGH",
  members: [
    { initials: "JK", tone: "purple", name: "Jordan Kim" },
    { initials: "EM", tone: "blue", name: "Emily Mitchell" },
    { initials: "MS", tone: "amber", name: "May Sh" },
  ],
  messages: [
    {
      initials: "JK",
      tone: "purple",
      text: "Moved the objective chips under the moves counter so the board gains ~24px vertically.",
      meta: "Jordan Kim · 11:04",
    },
    {
      initials: "EM",
      tone: "blue",
      text: "Looks good on iPhone SE. Can we keep the score popups from overlapping the goal chips?",
      meta: "Emily Mitchell · 11:12",
    },
    {
      initials: "JK",
      tone: "purple",
      text: "Yes — score floats will origin from the matched tiles and fade before they hit the HUD.",
      meta: "Jordan Kim · 11:18",
    },
  ],
}

export const BOARDS: BoardDefinition[] = [
  {
    id: "website-design",
    name: "Website design",
    icon: "/icons/layout-grid.svg",
    columns: WEBSITE_DESIGN_COLUMNS,
    defaultSelectedId: "security-review",
    detailCardId: "security-review",
    detail: SECURITY_REVIEW_DETAIL,
  },
  {
    id: "match-3-ui",
    name: "Match 3 UI",
    icon: "/icons/layout-grid-1.svg",
    columns: MATCH_3_COLUMNS,
    defaultSelectedId: null,
    detailCardId: "m3-hud",
    detail: MATCH_HUD_DETAIL,
  },
]

export function cloneColumns(columns: Column[]): Column[] {
  return columns.map((column) => ({
    ...column,
    cards: column.cards.map((card) => ({ ...card })),
  }))
}
