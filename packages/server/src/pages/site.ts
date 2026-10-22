import type { Config } from "../config.ts";
import { escapeHtml as e } from "./layout.ts";
import { LEGAL_PAGES } from "./legal.ts";

/**
 * The public site at the pages origin's root (ADR-0016): the home page, Pro and questions, built
 * from the sign-up prototype the owner approved. Served under the pages host's strict CSP, so the
 * style sheet is a file and nothing is inline.
 */
export const SITE_STYLE_PATH = "/_app/site.css";

export const SITE_STYLE = `:root{color-scheme:light dark;--paper:#fff;--paper-2:#f6f7f9;--ink:#202122;--ink-2:#54595d;--rule:#a2a9b1;--rule-2:#d5d9de;--link:#2f5fbf;--link-ink:#fff;--yes:#d5f5dc;--yes-ink:#14532d;--no:#fbe0e0;--no-ink:#7f1d1d;--part:#fbf3c9;--part-ink:#5b4a00;--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme: dark){:root{--paper:#101418;--paper-2:#1a1f25;--ink:#e8eaed;--ink-2:#a3abb3;--rule:#6f767d;--rule-2:#353b42;--link:#8fb0f0;--link-ink:#0b1220;--yes:#1d4d3e;--yes-ink:#c2f2d9;--no:#4d1d1d;--no-ink:#ffd3d3;--part:#4a4214;--part-ink:#fff1a6}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--body)}a{color:var(--link)}p,li{max-width:70ch}h1,h2,h3{text-wrap:balance}img{max-width:100%;height:auto;display:block}
.wrap{max-width:1100px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.top{border-bottom:1px solid var(--rule-2)}.top .wrap{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding-block:12px}
.mark{font:1.4rem/1 var(--display);font-variant:small-caps;letter-spacing:.02em;color:var(--ink);text-decoration:none}.nav{display:flex;gap:18px;flex-wrap:wrap;font-size:.95rem}
.hero{background:var(--paper-2);border-bottom:1px solid var(--rule-2)}.hero .wrap{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:40px;align-items:center;padding-block:44px}
.eyebrow{font:700 .75rem/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--link)}
.hero h1,.page h1{font:600 clamp(2rem,5vw,3rem)/1.1 var(--display);margin:12px 0}.lead{font-size:1.12rem;color:var(--ink-2)}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:.5rem;background:var(--paper);color:var(--link);padding:.25rem .5rem;z-index:1}.cta{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:20px 0 10px}.button{display:inline-block;background:var(--ink);color:var(--paper);font-weight:700;padding:13px 20px;border-radius:8px;text-decoration:none}.button.alt{background:var(--link);color:var(--link-ink)}
.fine{font-size:.86rem;color:var(--ink-2)}.ticks{list-style:none;padding:0;display:grid;gap:8px}.ticks li::before{content:"✓ ";color:var(--yes-ink);font-weight:700}
.shot{border:1px solid var(--rule-2);border-radius:10px;overflow:hidden;background:var(--paper)}.shot img{max-height:380px;object-fit:cover;object-position:top;width:100%}.shot p{margin:0;padding:10px 14px;font-size:.92rem;border-top:1px solid var(--rule-2)}
.page{padding-block:28px 60px}.page h2{font:400 1.6rem/1.25 var(--display);border-bottom:1px solid var(--rule);padding-bottom:3px;margin:32px 0 10px}.page h3{font-size:1.05rem;margin:20px 0 4px}
.infobox{float:right;width:21rem;max-width:100%;margin:0 0 16px 24px;border:1px solid var(--rule);background:var(--paper-2);border-collapse:collapse;font-size:.9rem}.infobox caption{font-weight:700;padding:6px}.infobox th,.infobox td{text-align:left;vertical-align:top;padding:5px 8px}
.scroll{overflow-x:auto}table.data{border-collapse:collapse;margin:12px 0;font-size:.92rem}table.data th,table.data td{border:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top}table.data thead th{background:var(--paper-2)}
.y{background:var(--yes);color:var(--yes-ink)}.n{background:var(--no);color:var(--no-ink)}.p{background:var(--part);color:var(--part-ink)}
.faq h2{font-size:1.25rem}.foot{border-top:1px solid var(--rule-2);margin-top:40px}.foot .wrap{display:flex;gap:16px;flex-wrap:wrap;padding-block:16px;font-size:.88rem;color:var(--ink-2)}
@media (max-width:860px){.hero .wrap{grid-template-columns:minmax(0,1fr);gap:24px;padding-block:28px}.infobox{float:none;width:100%;margin:12px 0}}`;

export interface SitePage {
  title: string;
  description: string;
  body: (config: Config) => string;
}

const signIn = (config: Config) => `${e(config.appOrigin)}/auth/github`;
/** Said beside every sign-in button: signing in is when the Terms start to apply. */
const AGREE = `<p class="fine">Signing in accepts the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy notice</a>.</p>`;

/** The public site's frame: header, the page, the footer with the legal pages. */
export function sitePage(config: Config, page: SitePage): string {
  const title = page.title === "RepoWiki" ? "RepoWiki" : `${e(page.title)} · RepoWiki`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${e(page.description)}"><link rel="stylesheet" href="${SITE_STYLE_PATH}"></head><body><a class="skip" href="#content">Skip to content</a><header class="top"><div class="wrap"><a class="mark" href="/">RepoWiki</a><nav class="nav"><a href="/example">Example</a><a href="/pro">Pro</a><a href="/questions">Questions</a><a href="${signIn(config)}">Log in</a></nav></div></header><div id="content">${page.body(config)}</div><footer class="foot"><div class="wrap"><a href="/questions">Questions</a><a href="/pro">Pro</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><span>support@repowiki.app</span></div></footer></body></html>`;
}

const home: SitePage = {
  title: "RepoWiki",
  description:
    "Cited pages about your GitHub projects, for internship and co-op applications, written from your code and checked against it.",
  body: (config) => `<section class="hero"><div class="wrap"><div>
<span class="eyebrow">For internship and co-op applications</span>
<h1>Show recruiters what you actually built.</h1>
<p class="lead">RepoWiki reads your public GitHub projects and writes a page about each one: what it does, how it works, what it's built with, and which parts are in your commits. Its sentences cite the code and commits they describe, so a reader can look at the code behind each one.</p>
<div class="cta"><a class="button" href="${signIn(config)}">Make my page with GitHub</a><a href="/example">See an example</a></div>${AGREE}
<p class="fine">Your first project is free. No card. Ready in about 10 to 30 minutes.</p>
<ul class="ticks"><li>One link for your resume, LinkedIn and application portals</li><li>Your part in group projects, read from git history</li><li>A wiki of your own code to prep for "walk me through a project"</li></ul>
</div><a class="shot" href="/example"><img src="/_app/example-top.jpg" alt="An example RepoWiki page: Jordan Avery, a fictional student, with five projects" width="1280" height="1150"><p><strong>Read the example</strong> · Jordan Avery, a fictional student, and the wiki for AlphaSettler, a Catan AI in Rust</p></a></div></section>
<main class="wrap page">
<table class="infobox"><caption>RepoWiki</caption><tbody>
<tr><th scope="row">What it is</th><td>A cited page about your projects</td></tr>
<tr><th scope="row">Used for</th><td>Internship and co-op applications</td></tr>
<tr><th scope="row">You get</th><td>A page about you, and a wiki for each project</td></tr>
<tr><th scope="row">Written by</th><td>An AI model, from your public code and git history</td></tr>
<tr><th scope="row">Sources</th><td>Cited to the code and commits it describes</td></tr>
<tr><th scope="row">Approved by</th><td>You, before anyone sees it</td></tr>
<tr><th scope="row">Edited by</th><td>No one: you publish it or you don't</td></tr>
<tr><th scope="row">Price</th><td>Free for one project<br><a href="/pro">Pro</a>: $5 a month, or $15 every 4 months</td></tr>
</tbody></table>
<h2>About RepoWiki</h2>
<p><strong>RepoWiki</strong> turns a university student's public GitHub projects into a cited page for internship and co-op applications, with a wiki for every project. An AI model writes it from the code and git history, and RepoWiki checks that every citation points at real code. The student doesn't write it, and a reader can follow any cited sentence to the code behind it.</p>
<p>An entry is one link on a resume, at <code>repowiki.app/&lt;your GitHub name&gt;</code>. It shows what a student built, what they built it with, and which parts of each project were their own work. It describes the code; it never praises it or grades it.</p>
<h3>The first look</h3>
<p>A recruiter skims a resume before deciding to read it. A personal project usually gets one line there, and a GitHub link that someone outside engineering won't open. An entry is written for that reader. The opening paragraph and the Works table take about 30 seconds: each project, what it's built with, and the student's part in it. Every row opens into the project's wiki for the engineer who wants more.</p>
<h3>Group projects</h3>
<p>Class projects and hackathons are shared work, and a resume line can't show who did what. An entry describes only the student's own commits, read from git history rather than claimed, and each teammate can publish their own entry about the same repository. Credit follows the names on each commit: its author, and anyone a <code>Co-authored-by</code> line names, as GitHub writes when it squash-merges a teammate's branch. Pairing with no such line counts for whoever committed.</p>
<h3>Technical interviews</h3>
<p>"Walk me through a project you built" is a standard interview question. A project's wiki explains the student's own code back to them, feature by feature, so you can use it to prepare for the interview.</p>
<h2>Compared with other ways to show a project</h2>
<div class="scroll"><table class="data"><thead><tr><th scope="col">Approach</th><th scope="col">Quick to skim</th><th scope="col">Checkable</th><th scope="col">Shows your share of team work</th><th scope="col">Effort</th></tr></thead><tbody>
<tr><th scope="row">Resume bullet</th><td class="y">Yes</td><td class="n">No</td><td class="n">No</td><td class="y">Low</td></tr>
<tr><th scope="row">GitHub link</th><td class="n">No</td><td class="y">Yes</td><td class="p">Hard to see</td><td class="y">None</td></tr>
<tr><th scope="row">Portfolio website</th><td class="y">Yes</td><td class="p">Rarely</td><td class="n">No</td><td class="n">High</td></tr>
<tr><th scope="row">RepoWiki entry</th><td class="y">Yes</td><td class="y">Follow the citations</td><td class="y">Yes</td><td class="y">Minutes</td></tr>
</tbody></table></div>
<p>An entry doesn't replace a portfolio site. It's the part a portfolio can't do: show the code behind the claims. Link to it from your portfolio.</p>
<h2>How an entry is made</h2>
<ol><li><strong>Sign in with GitHub.</strong> RepoWiki asks for no permissions: it reads only public repositories and can't change anything.</li>
<li><strong>Choose a project.</strong> Free includes one project, so pick the one to lead with. Not happy with the result? Rebuild it once, free, before you publish.</li>
<li><strong>RepoWiki writes the entry.</strong> It reads the code, groups it into features, and an AI model writes an article for each. RepoWiki then checks that every citation points at real code at that commit.</li>
<li><strong>You review and publish.</strong> Nothing is public until you confirm it describes your part accurately.</li></ol>
<h2>Limitations</h2>
<ul><li>Only public repositories where you have push access and at least one commit. Forks can't have an entry.</li>
<li>Every citation is checked to point at real code. Whether the code fully supports each sentence isn't checked automatically, which is why you read the entry before it's published.</li>
<li>Free entries need a GitHub account at least 30 days old.</li>
<li>Many courses don't allow assignment solutions to be posted publicly. RepoWiki only reads public repositories, so keep those private and it will never see them.</li></ul>
<p class="cta"><a class="button" href="${signIn(config)}">Make my page with GitHub</a></p>${AGREE}
</main>`,
};

const pro: SitePage = {
  title: "RepoWiki Pro",
  description: "Up to ten projects on your RepoWiki page, refreshed after you push.",
  body: (config) => `<main class="wrap page">
<span class="eyebrow">RepoWiki Pro</span><h1>Every project you'd put on a resume, on one page</h1>
<p class="lead">A Free entry shows one project. That's a good start, but it's only one project. A Pro entry shows more of your work: different languages and libraries, a timeline of what you built, and your part in each.</p>
<div class="scroll"><table class="data"><thead><tr><th scope="col"></th><th scope="col">Free</th><th scope="col">Pro</th></tr></thead><tbody>
<tr><th scope="row">Price</th><td>$0</td><td>$5 a month, or $15 every 4 months</td></tr>
<tr><th scope="row">Projects in your entry</th><td>1</td><td>Up to 10</td></tr>
<tr><th scope="row">New projects</th><td>1, ever</td><td>Up to 10 a month</td></tr>
<tr><th scope="row">Rebuild before you publish</th><td class="y">Once</td><td class="y">Yes</td></tr>
<tr><th scope="row">Refresh after a push</th><td class="n">No</td><td class="y">30 a month</td></tr>
<tr><th scope="row">Largest repository</th><td>1,000 files</td><td>3,000 files</td></tr>
<tr><th scope="row">GitHub account age</th><td>30 days or more</td><td>Any</td></tr>
<tr><th scope="row">A failed build</th><td colspan="2">Never counts against your plan</td></tr>
</tbody></table></div>
<h2>Paying for Pro</h2>
<ul><li>You pay on the day you upgrade, then again on the same day of each new period: every month at $5, or every 4 months at $15. Prices are in US dollars and include any sales tax. Stripe takes the card payment.</li>
<li>Pro renews until you cancel. To cancel, open the Billing page, choose Manage billing, and cancel on Stripe's page. Pro stays on until the end of the period you paid for, and your entry stays up.</li>
<li>"Up to 10" means at most 10 projects in your entry at once, and at most 10 new ones started in a month.</li>
<li>Changed your mind before using Pro? Ask within 7 days of your first payment for a full refund. Once you start a build with Pro, that payment can't be refunded. See <a href="/refunds">Refunds</a>.</li></ul>
<h2>During application season</h2>
<ul><li><strong>Refresh after you push.</strong> Finish a feature in the middle of applying, refresh the project, and the entry shows it. A Free entry stays at the commit it was built from.</li>
<li><strong>Show the project that fits each job.</strong> Add the project that fits each posting: the machine-learning one for a data internship, the web app for a front-end co-op.</li>
<li><strong>Document the big one.</strong> Capstones and team projects often pass 1,000 files; Pro covers up to 3,000.</li>
<li><strong>Pay for four months at a time.</strong> $15 covers four months of applying, 25% less than paying monthly. Cancel when you sign an offer, and your entry stays up.</li></ul>
<p class="cta"><a class="button" href="${signIn(config)}">Start free, upgrade any time</a></p>${AGREE}
</main>`,
};

const QUESTIONS: [string, string][] = [
  [
    "Is it written by AI?",
    "Yes. An AI model writes each sentence from your code and git history, and RepoWiki checks that every citation points at real code at that commit. It's told to describe what the code does, and never to praise it, criticize it or guess at why you did something. You read the whole thing before anyone else can.",
  ],
  [
    "Can I edit what it says?",
    "No, but you can correct it. The page says only what the code and git history show, never what anyone claims about them. If a sentence is wrong, tick it on your project page and say what's wrong: RepoWiki rewrites it from the code it cites and checks it again, or removes it if no version holds up. Free includes 3 corrections for each project, Pro 20 a month.",
  ],
  [
    "Will it say anything bad about my code?",
    "No. It doesn't rate code quality or comment on commit messages. Facts the code shows, like a TODO about a known bug, appear as plain facts in a project's wiki.",
  ],
  [
    "It was a group project. What will it say about my part?",
    "Your entry describes the parts of the project in your commits, read from git history, and each teammate can make their own entry about the same repository. A commit counts as yours when you made it, and as co-authored when its message names you in a Co-authored-by line, which GitHub adds when it squash-merges a branch you committed to. Pairing with no such line counts for whoever committed.",
  ],
  [
    "Which languages does it read?",
    "Any. It reads the structure of Python, TypeScript and Rust, so pages about code in those languages can name functions and how they call each other. Code in other languages, JavaScript among them, is still read, cited and described, file by file.",
  ],
  [
    "My projects are small. Is it worth it?",
    "Yes. A page shows a project at its real size: a small class project gets a short wiki with a few articles, like LecteurAide in the example, which has 8 commits.",
  ],
  [
    "How does it know which commits are mine?",
    "A commit counts as yours when its email address is one GitHub links to your account. If you've committed from another computer with a different email, add that email to your GitHub account before you build. Repositories in an organisation work if you can push to them.",
  ],
  [
    "Can I use class assignments?",
    "Check your course policy first: many don't allow solutions to be posted publicly. RepoWiki only reads public repositories, so a private one never appears.",
  ],
  [
    "My best work is in a private repository.",
    "RepoWiki only reads public repositories and asks GitHub for no permissions at all. If you can make the project public, it can have an entry.",
  ],
  [
    "Is my code used to train AI?",
    "No. Your code is sent to the model provider only to write your entry, under terms that don't allow training on it.",
  ],
  [
    "Who can see my page?",
    "Only you, until you publish it, and anyone you send a preview link to: each preview link works for one hour. After that it's a public page at repowiki.app/<your GitHub name>, like a portfolio site, and search engines can find it. Unpublish it any time.",
  ],
  [
    "How long does it take?",
    "About 10 to 30 minutes. Close the tab if you like; your entry is waiting when you sign in again.",
  ],
  [
    "Why can't I change my Free project?",
    "Free includes one project. Once it starts building, that's your Free project. If you don't like the result, rebuild it once, free, before you publish. If a build fails, it doesn't count and you can try again. Pro lets you add up to ten.",
  ],
  [
    "Does a Free entry stay current?",
    "It stays at the commit it was built from. Pro refreshes a project after you push.",
  ],
  [
    "What if I cancel Pro?",
    "Your published entry stays up, all of it. You can't refresh or add projects until you upgrade again.",
  ],
];

const questions: SitePage = {
  title: "Questions",
  description: "What students ask before making a RepoWiki page.",
  body: () =>
    `<main class="wrap page faq"><h1>Questions</h1><p class="lead">What students ask before making a page.</p>${QUESTIONS.map(
      ([q, a]) => `<h2>${e(q)}</h2><p>${e(a)}</p>`,
    ).join("")}</main>`,
};

/** Every page of the public site by path; the router serves exactly these. */
export const SITE_PAGES: Readonly<Record<string, SitePage>> = {
  "/": home,
  "/pro": pro,
  "/questions": questions,
  ...LEGAL_PAGES,
};
