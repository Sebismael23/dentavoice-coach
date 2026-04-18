// -----------------------------------------------------------------------------
// Test scenarios for automated coaching evaluation
// -----------------------------------------------------------------------------
// Each scenario is a multi-turn conversation with expected coaching outcomes.
// The test runner feeds segments incrementally to /api/coach and grades responses.
// -----------------------------------------------------------------------------

export interface TestSegment {
  speaker: 'prospect' | 'me';
  text: string;
  /** Delay in ms to simulate between segments (for timestamp spacing) */
  delayMs?: number;
}

export interface ExpectedOutcome {
  /** Which turn index (0-based, counting only prospect turns) triggers this check */
  afterProspectTurn: number;
  /** Expected action — null means we expect silence */
  action?: 'play' | 'generate' | null;
  /** Expected play_id (if action=play) */
  playId?: number;
  /** Play IDs that would also be acceptable */
  acceptablePlayIds?: number[];
  /** Expected phase */
  phase?: 'gatekeeper' | 'dm';
  /** Expected thread */
  thread?: string;
  /** Plays that must NOT be selected (wrong phase, already used, etc.) */
  forbiddenPlayIds?: number[];
  /** Description of what we're testing */
  description: string;
}

export interface TestScenario {
  name: string;
  callContext?: string;
  initialPhase?: 'gatekeeper' | 'dm';
  /** Pre-seed used play IDs (simulate long conversation) */
  initialUsedPlayIds?: number[];
  segments: TestSegment[];
  expectations: ExpectedOutcome[];
}

// ---------------------------------------------------------------------------
// SCENARIOS
// ---------------------------------------------------------------------------

export const SCENARIOS: TestScenario[] = [
  // =========================================================================
  // 1. HAPPY PATH: Cold call → gatekeeper → transfer → DM → close
  // =========================================================================
  {
    name: 'Happy path: cold → gatekeeper → get transfer → DM diagnostic → close',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: 'Thank you for calling Peach Dental, this is Sam speaking.' },
      { speaker: 'me', text: 'Hey Sam — quick one. When your front desk is already busy helping patients, do incoming calls go to voicemail or keep ringing?' },
      { speaker: 'prospect', text: 'They usually go to voicemail.' },
      { speaker: 'me', text: "That's actually smart. Quick question — when a patient calls wanting to book, can they actually get on the schedule or do they just leave a message?" },
      { speaker: 'prospect', text: "They leave a message and we call them back. What is this about? Who are you?" },
      { speaker: 'me', text: "This is Seb with DentaVoice. We help practices capture calls when the front desk is busy. I wasn't trying to sell you anything — just curious how you handle it." },
      { speaker: 'prospect', text: "Oh okay. Yeah I mean we handle it pretty well. We have a good team." },
      { speaker: 'me', text: "Understood. Who usually handles decisions about phone systems — the dentist or is there an office manager?" },
      { speaker: 'prospect', text: "That would be the office manager. She handles all that stuff." },
      { speaker: 'me', text: "Got it. Would it be unreasonable for me to try back this afternoon when she's in?" },
      { speaker: 'prospect', text: "Actually she's available right now if you want to talk to her. Let me transfer you." },
      // -- Transfer happens here --
      { speaker: 'prospect', text: "Hi this is Jennifer, Sam said you had a question about our phones?" },
      { speaker: 'me', text: "Hey Jennifer, thanks for taking a minute. I work with practices in the area on phone coverage — would it be unreasonable if I asked you a quick question?" },
      { speaker: 'prospect', text: "Sure go ahead." },
      { speaker: 'me', text: "How's your front desk team doing with the workload right now? Do they have enough bandwidth?" },
      { speaker: 'prospect', text: "Actually we just lost one of our receptionists two weeks ago. Now we only have two and they're swamped." },
      { speaker: 'me', text: "Just lost one? That's a lot on two people." },
      { speaker: 'prospect', text: "Yeah it's been rough. We're missing calls left and right." },
      { speaker: 'me', text: "Missing calls — when those go to voicemail, do patients usually call back or have they already booked somewhere else?" },
      { speaker: 'prospect', text: "Honestly a lot of them book somewhere else. We've definitely lost patients because of it." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        action: 'play',
        playId: 1,
        acceptablePlayIds: [1],
        phase: 'gatekeeper',
        description: 'First contact greeting → should suggest Play 1 (pattern interrupt opener)',
      },
      {
        afterProspectTurn: 2,
        action: 'play',
        description: 'Prospect asked "who are you" → should suggest Play 2 (identity reveal)',
        playId: 2,
        acceptablePlayIds: [2, 3],
        phase: 'gatekeeper',
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 3,
        description: 'Soft objection "we handle it pretty well" → should handle objection, NOT do pain math with gatekeeper',
        phase: 'gatekeeper',
        forbiddenPlayIds: [13, 14, 15, 16, 22, 23, 24, 25, 26, 27, 28],
      },
      {
        afterProspectTurn: 4,
        action: 'play',
        description: 'Prospect says "office manager handles that" → suggest transfer play',
        playId: 7,
        acceptablePlayIds: [7, 8, 9, 10],
        phase: 'gatekeeper',
      },
      {
        afterProspectTurn: 5,
        description: 'Prospect offers transfer → auto-detect should fire, phase should switch',
        phase: 'gatekeeper', // still gatekeeper in this segment
      },
      {
        afterProspectTurn: 7,
        description: 'DM says "just lost a receptionist, swamped" → should detect people thread, use DM diagnostic plays',
        thread: 'people',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      {
        afterProspectTurn: 9,
        description: 'DM admits losing patients → should pivot to pain math or close, stay on people thread',
        thread: 'people',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
    ],
  },

  // =========================================================================
  // 2. GATEKEEPER BRUSH-OFF: "We're not interested"
  // =========================================================================
  {
    name: 'Gatekeeper brush-off: "not interested" → objection handle → get email',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: 'Hello, Smile Dental.' },
      { speaker: 'me', text: 'Hey there — quick one. When your front desk is already busy, do incoming calls go to voicemail or keep ringing?' },
      { speaker: 'prospect', text: "We're not interested. We don't take sales calls." },
      { speaker: 'me', text: "Not trying to sell anything — I was just curious. One quick question before I go: when it gets busy, do patients ever end up on hold or going to voicemail?" },
      { speaker: 'prospect', text: "I mean yeah sometimes but that's normal. Everyone deals with that." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        action: 'play',
        playId: 1,
        acceptablePlayIds: [1],
        description: 'Standard greeting → Play 1 opener',
      },
      {
        afterProspectTurn: 1,
        description: '"Not interested / no sales calls" → must handle objection, NOT pitch, NOT pain math',
        phase: 'gatekeeper',
        acceptablePlayIds: [3, 4, 5, 6, 19, 33, 34],
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26, 27, 28],
      },
      {
        afterProspectTurn: 2,
        description: 'Soft deflection "that\'s normal" → should mirror/label and dig deeper, NOT pitch',
        phase: 'gatekeeper',
        forbiddenPlayIds: [13, 14, 15, 16, 22, 23, 24, 25, 26, 27, 28],
      },
    ],
  },

  // =========================================================================
  // 3. DIRECT TO OFFICE MANAGER (warm callback)
  // =========================================================================
  {
    name: 'Warm callback: directly to OM, skip gatekeeper plays',
    callContext: 'CALL TYPE: Scheduled callback (already warm)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)\nCONTACT NAME: Sarah\nPRACTICE: Harmony Dental\nPRIOR HISTORY: She asked about pricing last week, said to call back Friday\nCOACHING DIRECTIVE: This is a warm callback. Skip the cold opener (Play 1). Open with a reference to the previous conversation. Get straight to diagnostic or offer.\nCOACHING DIRECTIVE: Expected to reach OM directly. If confirmed, skip gatekeeper plays — start with Play 11 (warm OM open) or jump to diagnostic.',
    initialPhase: 'dm',
    segments: [
      { speaker: 'prospect', text: "Harmony Dental, this is Sarah." },
      { speaker: 'me', text: "Hey Sarah, this is Seb with DentaVoice. You mentioned last week you wanted to hear more about phone coverage — is now still a good time?" },
      { speaker: 'prospect', text: "Oh yeah! I remember. Yeah go ahead, I've got a few minutes." },
      { speaker: 'me', text: "Perfect. Last time you mentioned the phones were getting crazy. Is it a staffing thing or more of a volume thing?" },
      { speaker: 'prospect', text: "It's staffing. We lost someone and haven't been able to replace her. The two girls we have are doing their best but calls slip through." },
      { speaker: 'me', text: "Calls slipping through — when that happens, what's the patient experience like?" },
      { speaker: 'prospect', text: "They go to voicemail and honestly a lot of them don't call back. We've probably lost quite a few new patients." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'OM answers on callback → must NOT use Play 1 (cold opener). Should use warm open or reference prior conversation.',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        acceptablePlayIds: [11, 13],
      },
      {
        afterProspectTurn: 1,
        description: 'OM says "go ahead" → should jump to diagnostic, not re-intro',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 11, 12],
      },
      {
        afterProspectTurn: 2,
        description: '"Staffing, lost someone, calls slip through" → detect people thread immediately',
        thread: 'people',
        phase: 'dm',
        acceptablePlayIds: [14, 13, 19],
      },
      {
        afterProspectTurn: 3,
        description: '"Lost new patients, voicemail, don\'t call back" → pain math or pitch, stay people thread',
        thread: 'people',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
    ],
  },

  // =========================================================================
  // 4. MONEY THREAD: "We can't afford anything right now"
  // =========================================================================
  {
    name: 'Money thread: budget objection from OM',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)\nCOACHING DIRECTIVE: Expected to reach OM directly. If confirmed, skip gatekeeper plays — start with Play 11 (warm OM open) or jump to diagnostic.',
    initialPhase: 'dm',
    segments: [
      { speaker: 'prospect', text: "This is Lisa, the office manager. How can I help you?" },
      { speaker: 'me', text: "Hey Lisa, this is Seb with DentaVoice. I work with practices in the area on phone coverage. Would it be unreasonable if I asked you a quick question?" },
      { speaker: 'prospect', text: "Sure, but make it quick. We're swamped." },
      { speaker: 'me', text: "How's your front desk doing with the call volume right now?" },
      { speaker: 'prospect', text: "Honestly we're drowning. But we're on a tight budget right now — we just can't afford to add anything new." },
      { speaker: 'me', text: "Budget's tight. I hear that a lot right now." },
      { speaker: 'prospect', text: "Yeah, the doctor is really cutting costs wherever we can. We cancelled a bunch of stuff already." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'OM identifies herself → should be in DM phase, use OM plays',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      {
        afterProspectTurn: 2,
        description: '"Can\'t afford, tight budget" → detect money thread immediately',
        thread: 'money',
        phase: 'dm',
      },
      {
        afterProspectTurn: 3,
        description: '"Cutting costs" → stay money thread, use money-specific diagnostic',
        thread: 'money',
        acceptablePlayIds: [15, 19, 20, 21, 22, 23],
        forbiddenPlayIds: [14, 16, 17, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
    ],
  },

  // =========================================================================
  // 5. PROSPECT CONFUSION: "What are you talking about?"
  // =========================================================================
  {
    name: 'Prospect confusion: must never return null',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: "Hello?" },
      { speaker: 'me', text: "Hey — quick one. When your front desk is busy, do calls go to voicemail?" },
      { speaker: 'prospect', text: "What? What are you talking about? Who is this?" },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        action: 'play',
        description: '"What are you talking about / who is this" → MUST respond, never null. Play 2 or 33.',
        acceptablePlayIds: [2, 3, 33, 34],
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 22, 23, 24, 25],
      },
    ],
  },

  // =========================================================================
  // 6. NOTE: Seb-is-speaking suppression is client-side (shouldAskCoach).
  //    This scenario just verifies the API doesn't crash with Seb-only transcript.
  // =========================================================================
  {
    name: 'API handles Seb-only transcript gracefully',
    segments: [
      { speaker: 'prospect', text: 'Thank you for calling, this is Amy.' },
      { speaker: 'me', text: 'Hey Amy — quick one.' },
      { speaker: 'me', text: 'When your front desk is already busy helping patients,' },
      { speaker: 'me', text: 'do incoming calls go to voicemail or keep ringing?' },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'API should return a valid response (Play 1 or null) — no crash',
        acceptablePlayIds: [1],
      },
    ],
  },

  // =========================================================================
  // 7. CHAOS THREAD
  // =========================================================================
  {
    name: 'Chaos thread: OM doing everything herself',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)\nCOACHING DIRECTIVE: Expected to reach OM directly. If confirmed, skip gatekeeper plays — start with Play 11 (warm OM open) or jump to diagnostic.',
    segments: [
      { speaker: 'prospect', text: "This is Maria." },
      { speaker: 'me', text: "Hey Maria, quick question — how are you handling phone coverage when it gets busy?" },
      { speaker: 'prospect', text: "I do everything around here. I'm the front desk, the billing person, the scheduler. When the phone rings and I'm with a patient, it just goes to voicemail." },
      { speaker: 'me', text: "You do everything yourself? That's a lot." },
      { speaker: 'prospect', text: "Yeah, I'm wearing all the hats. The doctor doesn't want to hire anyone else so I'm stuck doing it all." },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        description: '"I do everything, front desk, billing, scheduler" → detect chaos thread',
        thread: 'chaos',
        phase: 'dm',
      },
      {
        afterProspectTurn: 2,
        description: '"Wearing all hats" → stay chaos thread, use Play 16',
        thread: 'chaos',
        acceptablePlayIds: [16, 19, 20, 21],
        forbiddenPlayIds: [14, 15, 17, 18],
      },
    ],
  },

  // =========================================================================
  // 8. DOCTOR THREAD: "I'd have to talk to the doctor"
  // =========================================================================
  {
    name: 'Doctor thread: OM defers to dentist',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "This is Karen, I'm the office manager." },
      { speaker: 'me', text: "Hey Karen, I work with practices on phone coverage. Quick question — when it gets busy, do calls go to voicemail?" },
      { speaker: 'prospect', text: "Sometimes, yeah. But honestly I'd have to talk to the doctor about anything new. He makes all the final decisions." },
      { speaker: 'me', text: "Makes sense. The doctor has the final say." },
      { speaker: 'prospect', text: "Yeah exactly. He's really particular about what we bring in. Last time someone tried to sell us something he wasn't happy." },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        description: '"Have to talk to the doctor, he makes decisions" → detect doctor thread',
        thread: 'doctor',
        phase: 'dm',
        acceptablePlayIds: [17, 30, 19],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 18],
      },
      {
        afterProspectTurn: 2,
        description: '"He\'s particular, wasn\'t happy" → stay doctor thread, handle the objection',
        thread: 'doctor',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 18, 25],
      },
    ],
  },

  // =========================================================================
  // 9. REVENUE THREAD: Direct to dentist, talking growth
  // =========================================================================
  {
    name: 'Revenue thread: dentist cares about new patient numbers',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Dentist / Owner (decision maker)\nCOACHING DIRECTIVE: Expected to reach dentist directly. If confirmed, skip gatekeeper — use Play 12 (warm dentist open) and focus on revenue/ROI thread.',
    segments: [
      { speaker: 'prospect', text: "This is Dr. Miller." },
      { speaker: 'me', text: "Hey Dr. Miller, this is Seb with DentaVoice. I work with practices on phone coverage. Would it be unreasonable if I asked you a quick question?" },
      { speaker: 'prospect', text: "Go ahead but make it quick, I've got a patient in ten minutes." },
      { speaker: 'me', text: "How's your new patient flow been this quarter?" },
      { speaker: 'prospect', text: "Honestly, not great. We've been spending a lot on marketing but the numbers aren't where I want them. We should be getting more from the spend." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'Dentist picks up → should suggest Play 12 (warm dentist open), not gatekeeper',
        phase: 'dm',
        acceptablePlayIds: [12, 13],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      },
      {
        afterProspectTurn: 2,
        description: '"Marketing spend, numbers not where I want" → detect revenue thread',
        thread: 'revenue',
        phase: 'dm',
        acceptablePlayIds: [18, 19, 20],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17],
      },
    ],
  },

  // =========================================================================
  // 10. ANSWERING SERVICE PROBE: gatekeeper mentions answering service
  // =========================================================================
  {
    name: 'Answering service probe: gatekeeper says they have one',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: "Bright Smiles Dental, how can I help you?" },
      { speaker: 'me', text: "Hey there — quick one. When your front desk is busy, do calls go to voicemail or keep ringing?" },
      { speaker: 'prospect', text: "We actually have an answering service that picks up when we can't." },
      { speaker: 'me', text: "Oh you do? That's smart. Can patients actually book through it?" },
      { speaker: 'prospect', text: "No, they just take a message and we call them back." },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        description: '"We have an answering service" → should use Play 10 (answering service probe)',
        playId: 10,
        acceptablePlayIds: [10, 19, 20],
        phase: 'gatekeeper',
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 2,
        description: '"Just take a message, call back" → gap question or get transfer, still gatekeeper',
        phase: 'gatekeeper',
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
      },
    ],
  },

  // =========================================================================
  // 11. MULTI-OBJECTION: "too expensive" then "let me think about it"
  // =========================================================================
  {
    name: 'Multi-objection: price then stall',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "Okay so what does this cost?" },
      { speaker: 'me', text: "Great question. It's 297 a month after the free trial. But here's the thing — the trial is completely free. No card, no commitment. The only question is whether you want to see the data." },
      { speaker: 'prospect', text: "Hmm, 297 is a lot. We're already paying for our phone system and the answering service." },
      { speaker: 'me', text: "I hear you. Budget's tight." },
      { speaker: 'prospect', text: "Yeah. Let me think about it and talk to the doctor. Can you call back next week?" },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: '"What does this cost" → price objection Play 29 or pivot to value',
        phase: 'dm',
        acceptablePlayIds: [25, 29, 19],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
      {
        afterProspectTurn: 1,
        description: '"297 is a lot, already paying" → handle price objection, NOT pitch again',
        phase: 'dm',
        acceptablePlayIds: [29, 23, 24],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 25],
      },
      {
        afterProspectTurn: 2,
        description: '"Let me think about it, call back" → Play 31 (think about it) or 30 (talk to doctor)',
        phase: 'dm',
        acceptablePlayIds: [30, 31, 34, 8],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 9, 10, 25, 26],
      },
    ],
  },

  // =========================================================================
  // 12. CLOSE SEQUENCE: prospect says yes
  // =========================================================================
  {
    name: 'Close: prospect agrees to trial → lock onboarding',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "You know what, that actually sounds really good. Let's do it. Let's try the free trial." },
      { speaker: 'me', text: "Awesome. Let me get you set up right now." },
      { speaker: 'prospect', text: "Okay, what do you need from me?" },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: '"Let\'s do it, let\'s try the trial" → Play 32 (close: lock onboarding)',
        action: 'play',
        playId: 32,
        acceptablePlayIds: [32, 25],
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 26, 27, 28, 29, 30, 31, 33, 34],
      },
      {
        afterProspectTurn: 1,
        description: '"What do you need from me" → continue close, collect info',
        phase: 'dm',
        acceptablePlayIds: [32],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 26, 27, 28, 29, 30, 31, 33, 34],
      },
    ],
  },

  // =========================================================================
  // 13. REAL CALL REPLAY: from your last test call (compressed)
  // =========================================================================
  {
    name: 'Real call replay: Sam at Peach Dental (key moments)',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: "Thank you for calling Peach Dental, this is Sam speaking. How can I help you?" },
      { speaker: 'me', text: "Hey Sam — quick one. When your front desk is already busy helping patients, do incoming calls go to voicemail or keep ringing?" },
      { speaker: 'prospect', text: "They usually go to voicemail." },
      { speaker: 'me', text: "That's actually smart. Quick question — when a patient calls wanting to book, can they actually get on the schedule through the service or do they just leave a message?" },
      { speaker: 'prospect', text: "They leave a message then we call them back. But why are you asking? What is this about?" },
      { speaker: 'me', text: "This is Seb with DentaVoice. We help practices capture calls when the front desk is busy. Wasn't trying to sell you anything." },
      { speaker: 'prospect', text: "Yeah I mean we handle it pretty well. We've got a good team." },
      { speaker: 'me', text: "Understood. Who handles decisions about phone systems — the dentist or office manager?" },
      { speaker: 'prospect', text: "The office manager. You'd have to talk to her." },
      { speaker: 'me', text: "Got it. Would it be unreasonable to try back this afternoon?" },
      { speaker: 'prospect', text: "Actually she's available right now if you want to talk to her." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'Greeting → Play 1',
        action: 'play',
        playId: 1,
        acceptablePlayIds: [1],
      },
      {
        afterProspectTurn: 2,
        description: '"Why are you asking, what is this about" → Play 2 identity reveal, NOT null',
        action: 'play',
        acceptablePlayIds: [2, 3, 33],
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 3,
        description: '"We handle it pretty well" → objection handling, still gatekeeper',
        phase: 'gatekeeper',
        forbiddenPlayIds: [13, 14, 15, 16, 22, 23, 24, 25, 26, 27, 28],
      },
      {
        afterProspectTurn: 4,
        description: '"Office manager, talk to her" → Play 7/8 transfer request',
        phase: 'gatekeeper',
        acceptablePlayIds: [7, 8, 9],
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 5,
        description: '"She\'s available, talk to her" → should prep for DM transition',
        phase: 'gatekeeper',
      },
    ],
  },

  // =========================================================================
  // 14. ONE-WORD ANSWERS: prospect gives minimal responses
  // =========================================================================
  {
    name: 'One-word answers: minimal prospect, coach must still guide',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Unknown — probably receptionist',
    segments: [
      { speaker: 'prospect', text: 'Hello.' },
      { speaker: 'me', text: 'Hey — quick one. When your front desk is busy, do calls go to voicemail?' },
      { speaker: 'prospect', text: 'Yeah.' },
      { speaker: 'me', text: 'Do patients usually call back or do they book somewhere else?' },
      { speaker: 'prospect', text: 'I dunno.' },
      { speaker: 'me', text: 'Fair enough. Who handles decisions about phone systems there?' },
      { speaker: 'prospect', text: 'Manager.' },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        action: 'play',
        playId: 1,
        acceptablePlayIds: [1],
        description: 'Minimal greeting → still Play 1',
      },
      {
        afterProspectTurn: 1,
        description: '"Yeah" (one word) → must still coach, not go silent. Follow-up question play.',
        phase: 'gatekeeper',
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 2,
        description: '"I dunno" → must not crash or go null on confused prospect',
        phase: 'gatekeeper',
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25],
      },
      {
        afterProspectTurn: 3,
        description: '"Manager" → suggest transfer play despite minimal answer',
        phase: 'gatekeeper',
        acceptablePlayIds: [7, 8, 9, 10],
        forbiddenPlayIds: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25],
      },
    ],
  },

  // =========================================================================
  // 15. THREAD SWITCH MID-CALL: starts money, pivots to people
  // =========================================================================
  {
    name: 'Thread switch: money → people mid-conversation',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "This is Rachel, office manager." },
      { speaker: 'me', text: "Hey Rachel, I work with practices on phone coverage. Quick question — how are things going?" },
      { speaker: 'prospect', text: "Budget is really tight right now. We've been cutting costs everywhere." },
      { speaker: 'me', text: "Budget's tight. What's driving that?" },
      { speaker: 'prospect', text: "Well honestly the bigger problem is we just lost two front desk people. That's why we're behind on everything — can't even answer phones half the time." },
      { speaker: 'me', text: "Two people at once? That's brutal." },
      { speaker: 'prospect', text: "Yeah, and we can't hire fast enough. Patients are going to voicemail and we're losing them." },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        description: '"Budget tight, cutting costs" → detect money thread',
        thread: 'money',
        phase: 'dm',
      },
      {
        afterProspectTurn: 2,
        description: '"Lost two front desk, can\'t answer phones" → should SWITCH to people thread',
        thread: 'people',
        phase: 'dm',
        acceptablePlayIds: [14, 19, 20],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15],
      },
      {
        afterProspectTurn: 3,
        description: '"Can\'t hire, patients going to voicemail" → stay people thread, pain math',
        thread: 'people',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18],
      },
    ],
  },

  // =========================================================================
  // 16. LONG CONVO: many plays already used, coach must find fresh play
  // =========================================================================
  {
    name: 'Long conversation: 5 plays used, coach must not repeat',
    initialPhase: 'dm',
    initialUsedPlayIds: [13, 14, 19, 1, 2],
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      // Simulate a long conversation — DM phase, people thread, many plays already used
      { speaker: 'prospect', text: "Okay so I get it, you help with phones. But I still don't see why I need this." },
      { speaker: 'me', text: "Fair point. Let me ask — how many new patient calls do you think you miss per week?" },
      { speaker: 'prospect', text: "I don't know, maybe five or six? But some of those probably aren't real leads." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: '"Don\'t see why I need this" with 5 plays used → must find a FRESH play, not repeat',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 19], // these are "used"
      },
      {
        afterProspectTurn: 1,
        description: '"Five or six missed, not real leads" → pain math (Play 22/23) or pitch',
        phase: 'dm',
        acceptablePlayIds: [20, 21, 22, 23, 24, 25],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 19],
      },
    ],
  },

  // =========================================================================
  // 17. COMPETITIVE QUESTION: "We already use Ruby/Weave/Mango"
  // =========================================================================
  {
    name: 'Competitor mention: "we already use [competitor]"',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "This is Diane." },
      { speaker: 'me', text: "Hey Diane, I work with practices on phone coverage. Quick question about how you handle overflow calls." },
      { speaker: 'prospect', text: "We already use Ruby Receptionists for that. We're good." },
      { speaker: 'me', text: "Oh nice, Ruby's solid. Can patients actually book through them or do they just take messages?" },
      { speaker: 'prospect', text: "They take messages, we call back. But it works fine for us." },
    ],
    expectations: [
      {
        afterProspectTurn: 1,
        description: '"We already use Ruby" → handle competitor objection, explore gaps, NOT pitch',
        phase: 'dm',
        acceptablePlayIds: [10, 19, 20, 26, 27, 28],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 32],
      },
      {
        afterProspectTurn: 2,
        description: '"They take messages, works fine" → probe for gap, don\'t give up',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 32],
      },
    ],
  },

  // =========================================================================
  // 18. IMPATIENT PROSPECT: "I have 30 seconds, what is this"
  // =========================================================================
  {
    name: 'Impatient prospect: very short patience, must be concise',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Cold call (first contact)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)',
    segments: [
      { speaker: 'prospect', text: "Yeah what is it, I've got thirty seconds." },
      { speaker: 'me', text: "I'll be quick. When your front desk is busy, patients go to voicemail right?" },
      { speaker: 'prospect', text: "Yeah so what. Everyone has that problem." },
      { speaker: 'me', text: "Totally normal. Most practices we work with lose about 20 percent of new patients to voicemail. We help capture those." },
      { speaker: 'prospect', text: "How much." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: '"30 seconds" → must suggest something concise, get to value fast',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      {
        afterProspectTurn: 1,
        description: '"So what, everyone has that" → handle dismissal, stay concise',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18],
      },
      {
        afterProspectTurn: 2,
        description: '"How much" → price play or trial close, NOT long diagnostic',
        phase: 'dm',
        acceptablePlayIds: [25, 29, 32],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18],
      },
    ],
  },

  // =========================================================================
  // 19. REFERRAL CALL: warm intro from another dentist
  // =========================================================================
  {
    name: 'Referral call: warm intro, skip cold opener entirely',
    initialPhase: 'dm',
    callContext: 'CALL TYPE: Referral (warm)\nEXPECTED FIRST CONTACT: Office Manager (decision maker)\nCONTACT NAME: Dr. Patel\nPRACTICE: Patel Family Dentistry\nPRIOR HISTORY: Referred by Dr. Johnson who is already a client\nCOACHING DIRECTIVE: This is a referral. Open with the referral source name. Skip cold opener and gatekeeper plays entirely.\nCOACHING DIRECTIVE: Expected to reach OM directly. If confirmed, skip gatekeeper plays — start with Play 11 (warm OM open) or jump to diagnostic.',
    segments: [
      { speaker: 'prospect', text: "Patel Family Dentistry, this is Priya." },
      { speaker: 'me', text: "Hey Priya, this is Seb. Dr. Johnson over at Johnson Dental suggested I give you a call — he's been using our phone coverage service and thought you'd find it helpful." },
      { speaker: 'prospect', text: "Oh Dr. Johnson! Yes, I know him. What exactly is it?" },
      { speaker: 'me', text: "We help practices capture calls when the front desk is busy. Instead of patients going to voicemail, our AI answers and books them right on the schedule." },
      { speaker: 'prospect', text: "That sounds interesting. We definitely miss calls when it gets busy." },
    ],
    expectations: [
      {
        afterProspectTurn: 0,
        description: 'Referral call → must NOT use Play 1 cold opener. Warm open or diagnostic.',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      {
        afterProspectTurn: 1,
        description: '"What exactly is it" on referral → brief explain, then diagnostic',
        phase: 'dm',
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
      {
        afterProspectTurn: 2,
        description: '"Sounds interesting, we miss calls" → diagnostic or trial close',
        phase: 'dm',
        acceptablePlayIds: [13, 14, 19, 20, 22, 23, 24, 25],
        forbiddenPlayIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      },
    ],
  },
];
