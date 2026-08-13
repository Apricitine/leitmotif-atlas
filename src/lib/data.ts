export const songs = [
  { id: "dont-forget", title: "Don't Forget", chapter: 1 },
  { id: "beginning", title: "Beginning", chapter: 1 },
  { id: "faint-glow", title: "Faint Glow", chapter: 2 },
  { id: "friendship", title: "Friendship", chapter: 1 },
  { id: "scarlet-forest", title: "Scarlet Forest", chapter: 1 },
  { id: "until-next-time", title: "Until Next Time", chapter: 3 },
  { id: "your-power", title: "Your Power", chapter: 1 },
  { id: "field-of-hopes-and-dreams", title: "Field of Hopes and Dreams", chapter: 1 },
  { id: "garden-of-hopes-and-dreams", title: "Garden of Hopes and Dreams", chapter: 5 },
  { id: "the-legend", title: "The Legend", chapter: 1 },
  { id: "the-door", title: "The Door", chapter: 1 },
  { id: "chase", title: "Chase", chapter: 1 },
  { id: "once-upon-a-time", title: "Once Upon a Time", chapter: 6 },
  { id: "before-the-story", title: "Before the Story", chapter: 2 },
  { id: "the-world-revolving", title: "The World Revolving", chapter: 1 },
  { id: "dialtone", title: "Dialtone", chapter: 2 },
  { id: "the-circus", title: "Circus", chapter: 1 },
]

export const motifs = [
  {
    id: "dont-forget",
    name: "Don't Forget (motif)",
    color: "#ac4dff",
    source: "dont-forget",
    songs: [
      "dont-forget", 
      "beginning", 
      "faint-glow", 
      "friendship", 
      "scarlet-forest", 
      "until-next-time", 
      "your-power",
      "field-of-hopes-and-dreams",
      "garden-of-hopes-and-dreams",
      "the-world-revolving"
    ]
  },
  {
    id: "once-upon-a-time",
    name: "Once Upon a Time (motif)",
    color: "#cf3a3a",
    source: "once-upon-a-time",
    songs: [
      "beginning",
      "garden-of-hopes-and-dreams",
      "before-the-story",
      "once-upon-a-time"
    ]
  },
  {
    id: "chase",
    name: "Chase (motif)",
    color: "#151a75",
    source: "chase",
    songs: [
      "chase",
      "the-door",
      "the-world-revolving"
    ]
  },
  {
    id: "freedom",
    name: "Freedom",
    color: "#ebaa2a",
    source: "the-world-revolving",
    songs: [
      "dialtone",
      "the-world-revolving",
      "the-circus"
    ]
  },
]
