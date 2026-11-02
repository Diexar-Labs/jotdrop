// "Plus gets it first" (Eric, 2 Nov 2026): JotDrop Plus votes on what comes next, and new features reach Plus
// about 4 weeks before everyone else. Eric decides this list; change it here.
// Removing an item drops its votes: the server only counts votes for items in this list.

/** What Plus can vote on. `id` stays the same once people voted on it; title and text may change. */
export const ROADMAP = [
  { id: 'mail-in', title: 'Mail to JotDrop', text: 'Forward an email, a ticket or a receipt to your own address and it becomes a note, attachments included.' },
  { id: 'iphone', title: 'An iPhone app', text: 'JotDrop on the iPhone and iPad, with your notes in sync.' },
  { id: 'smooth-lines', title: 'Smoother drawing', text: 'Lines that follow your hand in soft curves instead of short straight pieces.' },
  { id: 'templates', title: 'Note templates', text: 'Start a shopping list, a meeting note or a journal page from a template you made.' },
  { id: 'web-reminders', title: 'Reminders on the web', text: 'Set and get reminders in the web app and in Obsidian, not only on Android.' },
  { id: 'live-editing', title: 'Editing together, live', text: 'See the other person type in a shared note, instead of within about a minute.' },
];

/** How many items one account can vote for at a time. */
export const MAX_VOTES = 3;

/** Features in early access: Plus has them now, everyone else from `everyoneFrom` (about 4 weeks later). Empty until the first one ships. */
export const EARLY_FEATURES = [];
