import { escapeHtml as e } from "./layout.ts";
import type { SitePage } from "./site.ts";

const EFFECTIVE = "21 October 2026";

/** A legal page: plain sections of plain paragraphs, dated. */
function legal(title: string, description: string, sections: [string, string[]][]): SitePage {
  return {
    title,
    description,
    body: () =>
      `<main class="wrap page"><h1>${e(title)}</h1><p class="fine">Effective ${EFFECTIVE}</p>${sections
        .map(
          ([heading, paragraphs]) =>
            `<h2>${e(heading)}</h2>${paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}`,
        )
        .join("")}</main>`,
  };
}

const terms = legal("Terms of service", "The terms for using RepoWiki.", [
  [
    "Who we are",
    [
      "RepoWiki is run by Sean May, an individual in Massachusetts, USA (“we”). Write to support@repowiki.app with any question about these terms.",
    ],
  ],
  [
    "Your account",
    [
      "You sign in with GitHub, and you must be at least 13 years old. Your RepoWiki account belongs to your GitHub account, and you're responsible for what's done with it.",
    ],
  ],
  [
    "What RepoWiki makes",
    [
      "RepoWiki reads the public GitHub repositories you choose, and an AI model writes pages about them. RepoWiki checks that every citation points at real code, but generated text can still be wrong. You read your page before anyone else can, and you decide whether to publish it.",
    ],
  ],
  [
    "Your code and your page",
    [
      "You keep every right you have in your code. You let us copy your public repositories and GitHub profile, send them to our AI model provider, and store and show the pages made from them, only to run RepoWiki.",
      "Once you publish, anyone can read your page. Unpublish it any time and it stops being shown.",
    ],
  ],
  [
    "What you may not do",
    [
      "Don't publish about a repository you have no right to share, including coursework your course doesn't let you post. Don't try to break RepoWiki, overload it or get around its limits, and don't pretend to be someone else.",
    ],
  ],
  [
    "Plans and payment",
    [
      "Free and Pro include what the Pro page lists. Pro renews automatically, every month or every 4 months, until you cancel. Prices are in US dollars and include any sales tax. Stripe handles payment, and our refund policy covers refunds.",
      "We may change prices with at least 30 days' notice on this site; a new price applies from your next renewal.",
    ],
  ],
  [
    "Ending",
    [
      "You can unpublish, cancel Pro, or delete your account (Account, then Delete my account) at any time. We may suspend an account or remove a page that breaks these terms, and we'll tell you why.",
    ],
  ],
  [
    "No warranty",
    [
      "RepoWiki is provided as is. We don't promise that it will always be available or that its pages will be free of errors, and a page doesn't guarantee any job, internship or co-op.",
    ],
  ],
  [
    "Limits on liability",
    [
      "As far as the law allows, we aren't liable for indirect or consequential losses, and our total liability to you is no more than what you paid us in the 12 months before the claim.",
    ],
  ],
  [
    "Changes",
    [
      "We'll post any change here with a new date. If a change matters, we'll say so on this page at least 30 days before it applies.",
    ],
  ],
  [
    "Law",
    [
      "Massachusetts law governs these terms, and disputes about them go to the courts of Massachusetts.",
    ],
  ],
]);

const privacy = legal("Privacy", "What RepoWiki keeps about you, and who else handles it.", [
  [
    "From GitHub",
    [
      "When you sign in, GitHub tells us your user ID, login, name, avatar and the date your account was made. RepoWiki asks GitHub for no permissions, so the token it gets reads only public data. It's stored encrypted, used to list your public repositories, and deleted with your account; you can also revoke it at https://github.com/settings/applications. We don't get your email address.",
    ],
  ],
  [
    "Your projects",
    [
      "When you add a public repository, a build machine copies it, builds your pages and deletes the copy when the build ends. We keep the pages, the facts from git history they're built from, and a record of each build. A published wiki quotes commit subjects and names the people in the repository's git history by the names on their commits, so read the preview for both before you publish.",
    ],
  ],
  [
    "Payments",
    [
      "If you buy Pro, Stripe handles your card and billing email. We keep only your Stripe customer and subscription IDs, your plan, and when it renews.",
    ],
  ],
  [
    "Cookies",
    [
      "RepoWiki uses two cookies, both on app.repowiki.app: one keeps you signed in for up to 30 days, and one lasts 10 minutes while you sign in with GitHub. Public pages on repowiki.app set no cookies. There are no ads, analytics or tracking scripts.",
    ],
  ],
  [
    "Logs",
    [
      "Our server logs each request's path, status and timing, not your IP address. Cloudflare and Fly.io, which carry the traffic, see IP addresses as any web host does. We also keep a record of actions on your account, such as publishing, for security.",
    ],
  ],
  [
    "Who else handles it",
    [
      "GitHub (sign-in and your repositories), Anthropic (the AI model: it receives your code to write your pages and doesn't train on it), Stripe (payments), Fly.io (servers), Neon (the database) and Cloudflare (the domain, traffic and file storage). Each handles your data only to run RepoWiki.",
      "We never sell your data or use it for advertising.",
    ],
  ],
  [
    "Your choices",
    [
      "Unpublish any time, and your page stops being shown within a minute. To delete your account, open Account after you sign in and choose Delete my account: your pages come down within a minute, Pro is cancelled, and everything else is deleted within 30 days. We keep only your GitHub user ID and login, so no one else can take your page's address and that GitHub account can't sign up again, and Stripe keeps the payment records it must for tax.",
    ],
  ],
]);

const refunds = legal("Refunds", "How to cancel RepoWiki Pro, and when you get money back.", [
  [
    "Cancel any time",
    [
      "On the Billing page, choose Manage billing and cancel on Stripe's page. Pro stays on until the end of the period you paid for, then your account is on Free. Your published entry stays up.",
    ],
  ],
  [
    "Refunds",
    [
      "Changed your mind before using Pro? Write to support@repowiki.app within 7 days of your first payment and we'll refund it in full. Once you start a build with Pro, that payment can't be refunded.",
      "We also refund any charge made by mistake, such as a renewal after you cancelled or a duplicate charge. Other renewals aren't refunded, but cancelling stops the next one.",
    ],
  ],
  [
    "Failed builds",
    ["A build that fails never counts against your plan, so there's nothing to refund."],
  ],
  [
    "How refunds arrive",
    [
      "Refunds go back to the card you paid with, through Stripe, and usually arrive within 5 to 10 business days.",
    ],
  ],
]);

/** The legal pages the site's footer links to, by path (ADR-0016). */
export const LEGAL_PAGES: Readonly<Record<string, SitePage>> = {
  "/terms": terms,
  "/privacy": privacy,
  "/refunds": refunds,
};
