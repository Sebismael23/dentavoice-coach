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
        acceptablePlayIds: [16, 19, 20],
        forbiddenPlayIds: [14, 15, 17, 18],
      },
    ],
  },
];
