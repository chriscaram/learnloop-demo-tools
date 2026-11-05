// Static catalog content and the vocabulary used to build mock users and traffic.

/**
 * Lesson tuple: [title, durationMin]. Each course has two quizzes: one on the
 * middle lesson (questions 0-2) and one on the final lesson (questions 3-5).
 * Question tuple: [prompt, options, answerIndex].
 */
export const COURSES = [
  {
    key: 'sql', title: 'SQL for Analysts', category: 'Data', level: 'Beginner', popularity: 1.4, publishedDaysAgo: 380,
    summary: 'Query relational data with confidence, from simple filters to window functions.',
    lessons: [
      ['Why SQL still matters', 12], ['Selecting and filtering rows', 16], ['Sorting and limiting results', 11],
      ['Aggregations with GROUP BY', 18], ['Joining tables', 22], ['Subqueries and common table expressions', 19],
      ['Window functions', 21], ['Writing readable queries', 13],
    ],
    quiz: [
      ['Which clause filters rows before aggregation?', ['WHERE', 'HAVING', 'ORDER BY', 'LIMIT'], 0],
      ['What does SELECT DISTINCT do?', ['Removes duplicate rows from the result', 'Sorts the result', 'Counts rows', 'Joins two tables'], 0],
      ['Which keyword sorts results?', ['GROUP BY', 'ORDER BY', 'SORT', 'RANK'], 1],
      ['Which join keeps all rows from the left table?', ['INNER JOIN', 'CROSS JOIN', 'LEFT JOIN', 'SELF JOIN'], 2],
      ['A common table expression starts with which keyword?', ['WITH', 'USING', 'AS', 'FROM'], 0],
      ['Window functions are introduced by which keyword?', ['PARTITION', 'OVER', 'WINDOW', 'FRAME'], 1],
    ],
  },
  {
    key: 'dataviz', title: 'Data Visualization Fundamentals', category: 'Data', level: 'Beginner', popularity: 1.0, publishedDaysAgo: 340,
    summary: 'Pick the right chart, encode data honestly and design charts people can read at a glance.',
    lessons: [
      ['Choosing the right chart', 14], ['Perception and visual encoding', 17], ['Color with purpose', 15],
      ['Labels, titles and annotation', 12], ['Small multiples', 13], ['Dashboards that answer questions', 20],
      ['Common chart mistakes', 11],
    ],
    quiz: [
      ['Which encoding is read most accurately?', ['Position on a common scale', 'Area', 'Color hue', 'Angle'], 0],
      ['A good use of a line chart is…', ['Change over time', 'Parts of a whole', 'Unordered categories', 'Single values'], 0],
      ['Sequential color scales suit…', ['Ordered numeric data', 'Unrelated categories', 'Text labels', 'Binary flags'], 0],
      ['Small multiples help you…', ['Compare the same chart across groups', 'Save ink', 'Show a single number', 'Avoid axes'], 0],
      ['A chart title should ideally state…', ['The takeaway', 'The file name', 'The tool used', 'Nothing'], 0],
      ['Truncating a bar chart axis tends to…', ['Exaggerate differences', 'Improve accuracy', 'Hide outliers', 'Nothing'], 0],
    ],
  },
  {
    key: 'python', title: 'Python for Data Work', category: 'Data', level: 'Intermediate', popularity: 1.2, publishedDaysAgo: 300,
    summary: 'Use Python to load, clean and summarise everyday data without leaving your editor.',
    lessons: [
      ['Setting up a Python environment', 13], ['Core data types', 15], ['Working with files', 14],
      ['Lists, dictionaries and comprehensions', 18], ['Functions and modules', 16], ['Reading CSV and JSON', 15],
      ['Cleaning messy data', 22], ['Summaries and group-bys', 19], ['Automating a weekly report', 21],
    ],
    quiz: [
      ['Which type is immutable?', ['tuple', 'list', 'dict', 'set'], 0],
      ['What does len() return for a dict?', ['The number of keys', 'The number of values plus keys', 'The memory size', 'An error'], 0],
      ['Which statement opens a file safely?', ['with open(path) as f:', 'open(path).close()', 'file(path)', 'read(path)'], 0],
      ['csv.DictReader yields…', ['One dict per row', 'One list per column', 'A single string', 'Bytes'], 0],
      ['A list comprehension returns…', ['A new list', 'A generator only', 'A dict', 'None'], 0],
      ['Which keyword defines a function?', ['def', 'func', 'lambda only', 'fn'], 0],
    ],
  },
  {
    key: 'cloud', title: 'Cloud Foundations', category: 'Cloud', level: 'Beginner', popularity: 1.5, publishedDaysAgo: 400,
    summary: 'The core building blocks of public cloud: regions, compute, storage, networking, identity and cost.',
    lessons: [
      ['What the cloud is (and is not)', 14], ['Regions and availability zones', 17], ['Compute options', 18],
      ['Storage basics', 20], ['Networking essentials', 16], ['Identity and access', 22],
      ['Pricing and cost awareness', 18], ['Designing for failure', 15],
    ],
    quiz: [
      ['An availability zone is…', ['One or more isolated data centers in a region', 'A country', 'A pricing tier', 'A virtual network'], 0],
      ['Object storage is best for…', ['Files and blobs accessed over HTTP', 'Block devices for databases', 'CPU caches', 'DNS records'], 0],
      ['Which is a compute option?', ['Virtual machines', 'Buckets', 'Hosted zones', 'Policies'], 0],
      ['The principle of least privilege means…', ['Grant only the permissions needed', 'Give admins everything', 'Share credentials', 'Disable logging'], 0],
      ['Spreading across availability zones improves…', ['Resilience to a data center failure', 'Disk speed', 'Code quality', 'Latency to every user'], 0],
      ['Pay-as-you-go pricing means…', ['You pay for what you use', 'A fixed yearly fee', 'Free usage', 'Pricing per employee'], 0],
    ],
  },
  {
    key: 'serverless', title: 'Serverless Applications', category: 'Cloud', level: 'Intermediate', popularity: 1.1, publishedDaysAgo: 260,
    summary: 'Build event-driven applications from managed functions, queues and APIs.',
    lessons: [
      ['Thinking in events', 13], ['Functions as a service', 17], ['API gateways', 15], ['Managed queues and streams', 18],
      ['State and storage', 16], ['Observability for serverless', 19], ['Deploying with confidence', 14],
    ],
    quiz: [
      ['A cold start is…', ['Extra latency when a new function instance starts', 'A failed deployment', 'A database restore', 'A DNS change'], 0],
      ['Functions should usually be…', ['Stateless', 'Long-running', 'Single-threaded only', 'Hard-coded'], 0],
      ['An API gateway typically handles…', ['Routing HTTP requests to backends', 'Disk encryption', 'Compiling code', 'Email delivery'], 0],
      ['Queues help you…', ['Decouple producers from consumers', 'Store passwords', 'Render HTML', 'Resize images'], 0],
      ['Structured logs make it easier to…', ['Query and aggregate log data', 'Skip testing', 'Avoid deployments', 'Reduce memory'], 0],
      ['Idempotent handlers can…', ['Safely process the same event twice', 'Never fail', 'Run without code', 'Skip retries'], 0],
    ],
  },
  {
    key: 'iac', title: 'Infrastructure as Code', category: 'Cloud', level: 'Intermediate', popularity: 0.9, publishedDaysAgo: 120,
    summary: 'Describe infrastructure in versioned code and change it safely through reviews and pipelines.',
    lessons: [
      ['Why infrastructure as code', 12], ['Declarative and imperative approaches', 15], ['Stacks, modules and reuse', 18],
      ['Managing state and drift', 17], ['Testing infrastructure', 16], ['Pipelines for infrastructure', 19],
    ],
    quiz: [
      ['Declarative tools describe…', ['The desired end state', 'Each command to run', 'Only network rules', 'User interfaces'], 0],
      ['Drift is…', ['A difference between code and real infrastructure', 'A slow network', 'A test failure', 'A billing alert'], 0],
      ['Modules are used to…', ['Reuse infrastructure definitions', 'Encrypt data', 'Speed up CPUs', 'Write documentation'], 0],
      ['Infrastructure changes should go through…', ['Review and a pipeline', 'Manual console clicks', 'Email', 'Nothing'], 0],
      ['A plan or diff step shows…', ['What will change before it changes', 'Past invoices', 'User activity', 'Nothing useful'], 0],
      ['Storing infrastructure code in version control gives…', ['History and review', 'Faster servers', 'Free hosting', 'Fewer users'], 0],
    ],
  },
  {
    key: 'manager', title: 'First-Time Manager', category: 'Leadership', level: 'Beginner', popularity: 1.2, publishedDaysAgo: 360,
    summary: 'The habits that help new managers set direction, support people and protect their own time.',
    lessons: [
      ['From contributor to manager', 13], ['Setting expectations', 15], ['Running one-on-ones', 17], ['Delegating well', 16],
      ['Giving recognition', 11], ['Managing your time', 14], ['Building trust', 15], ['Your first 90 days', 18],
    ],
    quiz: [
      ['A one-on-one is mainly for…', ["The team member's topics", 'Status reporting only', 'Performance ratings', 'Planning holidays'], 0],
      ['Clear expectations include…', ['Outcomes and how success is judged', 'Only deadlines', 'Only hours worked', 'Nothing written'], 0],
      ['Good delegation hands over…', ['Outcome and authority', 'Only the boring parts', 'Tasks without context', 'Blame'], 0],
      ['Recognition works best when it is…', ['Specific and timely', 'Generic', 'Annual', 'Public only'], 0],
      ['Trust grows when managers…', ['Do what they said they would do', 'Avoid hard topics', 'Change priorities daily', 'Work alone'], 0],
      ['In the first 90 days, a new manager should first…', ['Listen and learn', 'Reorganise the team', 'Change all tools', 'Cut meetings to zero'], 0],
    ],
  },
  {
    key: 'meetings', title: 'Running Effective Meetings', category: 'Leadership', level: 'Beginner', popularity: 0.8, publishedDaysAgo: 330,
    summary: 'Hold fewer, shorter meetings that end with decisions and clear owners.',
    lessons: [
      ['Do we need a meeting?', 9], ['Agendas that work', 11], ['Facilitation basics', 14], ['Making decisions in the room', 15],
      ['Remote and hybrid meetings', 13], ['Follow-up and notes', 10],
    ],
    quiz: [
      ['A useful agenda lists…', ['Topics with the outcome wanted for each', 'Only the meeting title', 'The attendee list', 'Nothing'], 0],
      ['A facilitator mainly…', ['Guides the process', 'Makes every decision', 'Takes no part', 'Presents slides'], 0],
      ['Before scheduling a meeting, ask…', ['Could this be solved asynchronously?', 'Who is free?', 'Which room is nicest?', 'Nothing'], 0],
      ['Every action item needs…', ['An owner and a date', 'A slide', 'Five people', 'A vote'], 0],
      ['In hybrid meetings, a good practice is…', ['Everyone joins from their own device', 'Ignoring remote people', 'No agenda', 'Cameras off always'], 0],
      ['Meeting notes should capture…', ['Decisions and actions', 'Every word said', 'Only attendance', 'Nothing'], 0],
    ],
  },
  {
    key: 'feedback', title: 'Feedback and Difficult Conversations', category: 'Leadership', level: 'Intermediate', popularity: 1.0, publishedDaysAgo: 280,
    summary: 'Give and receive feedback that changes behaviour, and stay steady in hard conversations.',
    lessons: [
      ['Why feedback is hard', 11], ['A simple feedback model', 14], ['Preparing for a difficult conversation', 16],
      ['Listening under pressure', 15], ['Handling emotions', 14], ['Agreeing next steps', 12], ['Receiving feedback yourself', 13],
    ],
    quiz: [
      ['Effective feedback describes…', ['Specific behaviour and its impact', 'Personality traits', 'Rumours', 'Other people'], 0],
      ['Feedback is most useful when it is…', ['Close in time to the event', 'Saved for the annual review', 'Anonymous only', 'Vague'], 0],
      ['Preparing for a hard conversation includes…', ['Clarifying the outcome you want', 'Rehearsing a script word for word', 'Inviting the whole team', 'Avoiding it'], 0],
      ['Active listening includes…', ['Summarising what you heard', 'Planning your reply', 'Interrupting', 'Checking your phone'], 0],
      ['When emotions run high, it helps to…', ['Pause and acknowledge them', 'Ignore them', 'Raise your voice', 'End the job'], 0],
      ['When receiving feedback, start by…', ['Asking questions to understand', 'Defending yourself', 'Changing the subject', 'Disagreeing'], 0],
    ],
  },
  {
    key: 'uxr', title: 'UX Research Basics', category: 'Design', level: 'Beginner', popularity: 1.1, publishedDaysAgo: 310,
    summary: 'Plan, run and share lightweight research that answers real product questions.',
    lessons: [
      ['What research is for', 11], ['Writing research questions', 13], ['Recruiting participants', 15], ['Running interviews', 19],
      ['Usability testing', 20], ['Synthesising findings', 17], ['Sharing insights', 12], ['Research on a budget', 14],
    ],
    quiz: [
      ['A good research question is…', ['Specific and answerable', 'A yes/no feature request', 'About the team', 'Very broad'], 0],
      ['In interviews, prefer questions that are…', ['Open-ended', 'Leading', 'Hypothetical only', 'About price only'], 0],
      ['Recruit participants who…', ['Match the people you design for', 'Work on your team', 'Are always available', 'Are experts in UX'], 0],
      ['A usability test observes people…', ['Trying to complete tasks', 'Rating colors', 'Reading a manual', 'Writing code'], 0],
      ['Affinity mapping helps to…', ['Group observations into themes', 'Schedule sessions', 'Pay participants', 'Write code'], 0],
      ['Five participants in a usability test usually…', ['Reveal the most common problems', 'Prove statistical significance', 'Are too few to learn anything', 'Replace analytics'], 0],
    ],
  },
  {
    key: 'ixd', title: 'Interaction Design Patterns', category: 'Design', level: 'Intermediate', popularity: 0.9, publishedDaysAgo: 220,
    summary: 'Proven patterns for navigation, forms, feedback, errors and data-heavy screens.',
    lessons: [
      ['Patterns and when to use them', 10], ['Navigation', 14], ['Forms and input', 18], ['Feedback and system status', 12],
      ['Empty states', 9], ['Errors and recovery', 13], ['Tables and lists', 15], ['Search and filtering', 16],
      ['First-run experiences', 12], ['Accessibility in interaction', 17],
    ],
    quiz: [
      ['Labels on form fields should be…', ['Visible and above or beside the field', 'Only placeholders', 'Hidden', 'Icons only'], 0],
      ['System status should be…', ['Visible within a reasonable time', 'Hidden from users', 'Only in logs', 'Shown once a day'], 0],
      ['A good empty state…', ['Explains what goes here and how to start', 'Is blank', 'Shows an error', 'Hides navigation'], 0],
      ['Error messages should…', ['Say what happened and how to fix it', 'Show a code only', 'Blame the user', 'Disappear instantly'], 0],
      ['Filters work best when…', ['Results update clearly and filters are easy to clear', 'They are hidden', 'Only one can be used', 'They reload the app'], 0],
      ['Keyboard accessibility means…', ['Every action works without a mouse', 'Shortcuts only', 'No focus styles', 'Mouse only'], 0],
    ],
  },
  {
    key: 'ds', title: 'Design Systems in Practice', category: 'Design', level: 'Advanced', popularity: 0.8, publishedDaysAgo: 80,
    summary: 'Build and run a design system that teams actually adopt: tokens, components, docs and governance.',
    lessons: [
      ['What a design system is', 11], ['Design tokens', 14], ['Components and variants', 18], ['Documentation people read', 13],
      ['Governance and contribution', 15], ['Versioning and releases', 14], ['Adoption across teams', 16],
      ['Measuring a design system', 13], ['Evolving the system', 12],
    ],
    quiz: [
      ['Design tokens store…', ['Named design decisions such as colors and spacing', 'Passwords', 'User data', 'Build logs'], 0],
      ['A component variant is…', ['A defined alternative of the same component', 'A bug', 'A new product', 'A token'], 0],
      ['Good component docs include…', ['Usage guidance and examples', 'Only source code', 'Nothing', 'Only screenshots'], 0],
      ['Semantic versioning signals breaking changes with…', ['A major version bump', 'A patch bump', 'A new logo', 'Nothing'], 0],
      ['A contribution model defines…', ['How teams propose and add to the system', 'Salaries', 'Office hours', 'Hosting'], 0],
      ['Adoption can be measured by…', ['Component usage in products', 'Number of meetings', 'Lines of CSS', 'Team size'], 0],
    ],
  },
];

export const FIRST_NAMES = [
  'Aaron', 'Abigail', 'Adele', 'Ahmed', 'Aiko', 'Alba', 'Alex', 'Alice', 'Amara', 'Andre', 'Anika', 'Arjun', 'Ava', 'Ben',
  'Bianca', 'Bruno', 'Carla', 'Carlos', 'Chen', 'Chloe', 'Daniel', 'Dara', 'David', 'Elena', 'Eli', 'Emma', 'Erik', 'Eva',
  'Farah', 'Felix', 'Fiona', 'Gabriel', 'Grace', 'Hana', 'Hugo', 'Ines', 'Isaac', 'Ivy', 'Jakob', 'James', 'Jana', 'Jonas',
  'Julia', 'Kai', 'Kara', 'Kenji', 'Laura', 'Leo', 'Lina', 'Lucas', 'Maya', 'Mei', 'Mila', 'Nadia', 'Nina', 'Noah', 'Omar',
  'Paula', 'Quinn', 'Rafael', 'Rosa', 'Ruth', 'Sam', 'Sara', 'Tariq', 'Theo', 'Uma', 'Vera', 'Victor', 'Wen', 'Yara', 'Zoe',
];

export const LAST_NAMES = [
  'Abbott', 'Alvarez', 'Andersen', 'Baker', 'Becker', 'Bianchi', 'Brooks', 'Carter', 'Castro', 'Chen', 'Cohen', 'Costa',
  'Dahl', 'Dubois', 'Ellis', 'Evans', 'Fischer', 'Flores', 'Foster', 'Garcia', 'Gray', 'Hansen', 'Hayes', 'Ito', 'Jansen',
  'Jensen', 'Kaur', 'Keller', 'Kim', 'Kowalski', 'Lambert', 'Larsen', 'Lopez', 'Martin', 'Meyer', 'Moreau', 'Morris',
  'Murphy', 'Nakamura', 'Nguyen', 'Novak', 'Okafor', 'Olsen', 'Owens', 'Patel', 'Perez', 'Quinn', 'Reyes', 'Rossi',
  'Santos', 'Schmidt', 'Silva', 'Singh', 'Sato', 'Tanaka', 'Turner', 'Vargas', 'Walsh', 'Weber', 'Young', 'Zimmer',
];

/** Browser user agents with relative frequency. */
export const BROWSER_USER_AGENTS = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 26],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 16],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 12],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 10],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 7],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 4],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 11],
  ['Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 4],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 6],
  ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 4],
];

export const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** CloudFront edge locations with relative weight. */
export const EDGE_LOCATIONS = [
  ['IAD89-P1', 10], ['IAD61-P3', 6], ['JFK50-P2', 7], ['ORD58-C1', 6], ['ATL56-P1', 4], ['DFW57-P5', 4], ['LAX50-C2', 5],
  ['SEA19-C3', 3], ['YTO50-P1', 3], ['LHR61-P4', 8], ['AMS58-P2', 5], ['FRA56-P5', 6], ['CDG52-P3', 4], ['MAD53-C1', 3],
  ['DUB56-P1', 3], ['ARN56-C1', 2], ['WAW51-P2', 2], ['BOM78-P1', 2], ['SIN2-P4', 2], ['NRT57-P3', 2], ['SYD62-P1', 2],
  ['GRU3-C1', 2],
];

/** UTC hour-of-day weights for session starts (learners across the Americas and Europe). */
export const HOURLY_WEIGHTS = [
  2.6, 2.0, 1.6, 1.4, 1.4, 1.7, 2.6, 3.6, 4.6, 5.3, 5.6, 5.6, 6.0, 6.6, 7.0, 7.0, 6.8, 7.0, 7.4, 7.2, 6.4, 5.4, 4.2, 3.2,
];

/** Day-of-week multipliers, Sunday first; mean is 1. */
export const WEEKDAY_FACTORS = [0.72, 1.12, 1.14, 1.13, 1.1, 1.05, 0.74];
