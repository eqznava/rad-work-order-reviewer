// Rad Work Order Reviewer - rules engine.
// Pure functions with no Forge imports, so they can be unit tested with Node.
// The engine reads labelled fields from the Work Order text and applies fixed
// rules. The language model never decides a finding: it only presents them.

// ---- Small helpers ---------------------------------------------------------

// "1,800" -> 1800. Returns null when there is no number.
const toNumber = (text) => {
  if (text === undefined || text === null) return null;
  const value = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
};

// 1800 -> "1,800"
const fmt = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });

// First capture group of a pattern, or null.
const grab = (text, pattern) => {
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
};

// 6 -> "6 minutes", 857 -> "14.3 hours"
const duration = (minutes) =>
  minutes < 120 ? `${fmt(Math.round(minutes))} minutes` : `${fmt(minutes / 60)} hours`;

// ---- Step 1: read the Work Order -------------------------------------------

/**
 * Reads the labelled fields of a Work Order description. A field that is not
 * found stays null; the engine never guesses a value.
 */
export function parseWorkOrder(text) {
  const t = String(text || '');
  const task = grab(t, /Task:\s*([^\n]*)/i) || '';
  const airLine = grab(t, /Air sampling:\s*([^\n.]*)/i);
  const pasLine = grab(t, /Personal air samplers:\s*([^\n.]*)/i);
  const dosimetry = grab(t, /Dosimetry:\s*([^\n.]*)/i);
  const prejob = grab(t, /Prejob brief:\s*([^\n.]*)/i);
  const airborneWord = grab(task, /\b(grind\w*|re-?weld\w*|welding|burn\w*|cut\w*|saw\w*|vacuum\w*|sweep\w*|machin\w*|compressed air)\b/i);
  const breachWord = grab(task, /\b(cut out|cut and remove|disassembl\w*|breach\w*|remove internals)\b/i) ||
    grab(t, /\b(system breach|gland is opened)\b/i);

  return {
    task,
    radWorkPermit: grab(t, /Rad Work Permit:\s*([\w-]+)/i),
    doseSetpoint: toNumber(grab(t, /Accumulated dose setpoint:\s*([\d,.]+)\s*mRem/i)),
    rateSetpoint: toNumber(grab(t, /Dose rate setpoint:\s*([\d,.]+)\s*mR\/h/i)),
    coverage: (grab(t, /Coverage:\s*(continuous|intermittent)/i) || '').toLowerCase() || null,
    prejobLine: prejob,
    prejobCompleted: prejob ? /completed/i.test(prejob) : false,
    rpNotAtBrief: /RP attendance not required/i.test(t),
    surveyNumber: grab(t, /survey\s+(\d{2}-\d{3,5})\s+dated/i),
    surveyDeferred: /survey[^\n.]*to be performed/i.test(t),
    contact: toNumber(grab(t, /([\d,]+)\s*mR\/h\s+contact/i)),
    at30cm: toNumber(grab(t, /([\d,]+)\s*mR\/h\s+at 30 cm/i)),
    generalArea: toNumber(grab(t, /([\d,]+)\s*mR\/h\s+general area/i)),
    contamination: toNumber(grab(t, /Contamination:\s*(?:less than\s+)?([\d,]+)\s*dpm\/100 cm2/i)),
    dryRemovable: /dry removable/i.test(t),
    alphaLevel: toNumber(grab(t, /Alpha Level\s*([123])/i)),
    alphaNotEvaluated: /Alpha contamination:\s*not evaluated/i.test(t),
    airLine,
    airNegated: airLine ? /^not (required|planned)/i.test(airLine) : false,
    airType: airLine ? grab(airLine, /\b(breathing zone|work area|general area|grab)\b/i) : null,
    pasLine,
    pasNegated: pasLine ? /not required/i.test(pasLine) : false,
    stayTrackingNegated: /Stay time tracking:\s*not required/i.test(t),
    stayMinutes: toNumber(grab(t, /Stay time:\s*([\d,]+)\s*minutes/i)),
    stayBasis: grab(t, /based on the (general area|30 cm|contact) dose rate/i),
    stopPoint: /Stop point:/i.test(t),
    noHotSpots: /No hot spots/i.test(t),
    dosimetryLine: dosimetry,
    extremityAddressed: /extremit/i.test(t),
    multiBadging: /multi-?badg|reposition/i.test(t),
    dosimetersOptional: /dosimeters? (is|are) optional/i.test(t),
    continueOnAlarm: /dosimeter alarms?, continue/i.test(t),
    seniorTechnician: /senior technician|ANSI[ -]?(N?18\.1|\/?ANS[ -]?3\.1|3\.1)/i.test(t),
    airborneWord,
    breachWord,
    diving: /\bdiv(er|ing)\b/i.test(task),
    radiography: /radiograph/i.test(task),
    remoteCamera: /\bcamera/i.test(t),
    remoteAudio: /audio communication|radio contact|constant communication|in communication with/i.test(t),
    remoteTelemetry: /telemetry|teledosimetry|remote monitoring/i.test(t),
  };
}

// ---- Step 2: apply the rules -----------------------------------------------

/**
 * Applies the rules for the cards that are REVIEWED. `reviewed` is a list of
 * document numbers such as ['010', '002', '003'].
 * Returns findings grouped by section plus the values that were read.
 */
export function reviewWorkOrder(text, reviewed = ['010', '002', '003']) {
  const wo = parseWorkOrder(text);
  const out = { conflicts: [], missing: [], covered: [], notNeeded: [], duringJob: [] };
  const add = (group, source, sentence) => out[group].push({ source, text: sentence });
  const has = (number) => reviewed.includes(number);

  // The reading used as the work area dose rate. Field practice from a senior
  // RP technician: 30 cm for maintenance on equipment.
  const workRate = wo.at30cm;
  const stayRequired = workRate !== null && workRate > 1500;

  if (has('010')) {
    const C = 'NISP-RP-010';

    if (wo.radWorkPermit) add('covered', `${C}, 6.1.1, 6.1.2`, `Rad Work Permit ${wo.radWorkPermit} is identified.`);
    else add('missing', `${C}, 6.1.1, 6.1.2`, 'The WO does not identify the Rad Work Permit.');

    // Coverage. When stay time tracking applies, a technician must give it
    // continuous attention and keep direct communication with the workers.
    // Continuous coverage can be remote, but only with camera, audio and
    // telemetry together (Attachment 1).
    const remoteParts = [['remote camera surveillance', wo.remoteCamera], ['audio communication with the work area', wo.remoteAudio], ['telemetry', wo.remoteTelemetry]];
    const remoteMissing = remoteParts.filter((part) => !part[1]).map((part) => part[0]);
    if (!wo.coverage) add('missing', `${C}, Attachment 1`, 'The WO does not state the coverage type (continuous or intermittent).');
    else if (wo.coverage === 'intermittent' && stayRequired && remoteMissing.length === 0) add('covered', `${C}, Attachment 1, 6.4.2 b`, 'The technician is not continuously at the work site, but coverage of the activity is continuous by remote monitoring: camera, audio communication and telemetry are stated.');
    else if (wo.coverage === 'intermittent' && stayRequired) add('conflicts', `${C}, 6.4.2 b, 6.4.3, Attachment 1`, `The WO assigns intermittent coverage, but stay time tracking applies (30 cm dose rate of ${fmt(workRate)} mR/h is above 1,500 mrem/hour). Tracking needs a technician giving it continuous attention and direct communication with the workers. Coverage can be continuous without the technician at the work site only by remote monitoring, and the WO does not state: ${remoteMissing.join(', ')}.`);
    else add('covered', `${C}, Attachment 1`, `Coverage type is stated: ${wo.coverage}.`);

    if (wo.rpNotAtBrief) add('conflicts', `${C}, 6.1.4`, 'The WO says RP attendance is not required at the prejob brief, but RP communicates with the workers before the job so they understand the radiological conditions, protective requirements and work restrictions.');
    else if (wo.prejobCompleted) add('covered', `${C}, 6.1.4, 6.1.6`, 'The prejob brief is marked as completed.');
    else if (wo.prejobLine) add('missing', `${C}, 6.1.6`, 'The prejob brief is not marked as completed.');
    else add('missing', `${C}, 6.1.4, 6.1.6`, 'The WO does not mention the prejob brief.');

    if (wo.doseSetpoint !== null && wo.rateSetpoint !== null) add('covered', `${C}, 6.3.1 a, b`, `Setpoints are stated: accumulated dose ${fmt(wo.doseSetpoint)} mRem and dose rate ${fmt(wo.rateSetpoint)} mR/h.`);
    else add('missing', `${C}, 6.3.1 a, b`, 'The WO does not state both Rad Work Permit setpoints (accumulated dose in mRem and dose rate in mR/h).');

    // Stay time tracking: required above 1,500 mrem/hour.
    if (workRate === null) add('missing', `${C}, 6.4.1`, 'The 30 cm dose rate is not stated, so the need for stay time tracking could not be checked.');
    else if (stayRequired && wo.stayTrackingNegated) add('conflicts', `${C}, 6.4.1`, `The WO says stay time tracking is not required, but the 30 cm dose rate of ${fmt(workRate)} mR/h is above the 1,500 mrem/hour threshold.`);
    else if (stayRequired && wo.stayMinutes !== null) add('covered', `${C}, 6.4.1`, `Stay time is stated (${fmt(wo.stayMinutes)} minutes); tracking applies because the 30 cm dose rate of ${fmt(workRate)} mR/h is above 1,500 mrem/hour.`);
    else if (stayRequired) add('missing', `${C}, 6.4.1`, `The WO does not address stay time tracking, which applies because the 30 cm dose rate of ${fmt(workRate)} mR/h is above the 1,500 mrem/hour threshold.`);
    else add('notNeeded', `${C}, 6.4.1`, `Stay time tracking: the 30 cm dose rate of ${fmt(workRate)} mR/h is not above the 1,500 mrem/hour threshold.`);

    // Stay time arithmetic against the accumulated dose setpoint.
    if (wo.stayMinutes !== null && workRate !== null && wo.doseSetpoint !== null) {
      const expected = (wo.stayMinutes / 60) * workRate;
      const eighty = 0.8 * wo.doseSetpoint;
      const basis = wo.stayBasis && wo.stayBasis.toLowerCase() !== '30 cm' ? ` The WO based its stay time on the ${wo.stayBasis} dose rate, not the 30 cm reading.` : '';
      if (expected > eighty) add('conflicts', `${C}, 6.3.5, 6.4.1`, `The stay time is not consistent with the setpoint: ${fmt(wo.stayMinutes)} minutes at ${fmt(workRate)} mR/h is about ${fmt(Math.round(expected))} mRem, above 80% of the ${fmt(wo.doseSetpoint)} mRem setpoint, which is ${fmt(eighty)} mRem.${basis}`);
      else add('covered', `${C}, 6.3.5, 6.4.1`, `The stay time is consistent with the setpoint: ${fmt(wo.stayMinutes)} minutes at ${fmt(workRate)} mR/h is about ${fmt(Math.round(expected))} mRem, within 80% of the ${fmt(wo.doseSetpoint)} mRem setpoint, which is ${fmt(eighty)} mRem.${basis}`);
    }

    if (wo.stopPoint) add('covered', `${C}, 6.2.4 d`, 'A stop point for surveys is listed.');
    else add('missing', `${C}, 6.2.4 d, 6.2.1 c`, 'The WO does not list steps or conditions where workers must stop for additional surveys or protective actions.');

    if (wo.dosimetersOptional) add('conflicts', `${C}, 6.3.1 a, b, 6.3.5`, 'The WO makes electronic dosimeters optional, but the dose and dose rate setpoints cannot be monitored without them.');
    if (wo.continueOnAlarm) add('conflicts', `${C}, 6.3.5`, 'The WO tells workers to continue working when a dosimeter alarms, but a worker leaves the area when cumulative dose exceeds 80% of the dose setpoint.');

    // Extremity dosimetry screening. Card criteria: extremity dose likely to
    // exceed twice the whole body dose AND to exceed 500 mrem over the job.
    // Screening bound: hands stay at the contact reading while the body
    // accumulates the full dose setpoint at the general area reading.
    if (wo.contact !== null && workRate !== null) {
      const twice = wo.contact >= 2 * workRate;
      const canBound = wo.generalArea !== null && wo.generalArea > 0 && wo.doseSetpoint !== null;
      const bound = canBound ? (wo.contact / wo.generalArea) * wo.doseSetpoint : null;
      const minutes = (500 / wo.contact) * 60;
      const readings = `contact ${fmt(wo.contact)} mR/h, 30 cm ${fmt(workRate)} mR/h`;
      if (wo.extremityAddressed) add('covered', `${C}, Attachment 8, 2.0 - 2.3`, 'Extremity dosimetry is addressed in the WO.');
      else if (!twice) add('notNeeded', `${C}, Attachment 8, 2.0 - 2.3`, `Extremity dosimetry screening: the contact dose rate is less than twice the 30 cm dose rate (${readings}).`);
      else if (canBound && bound < 500) add('notNeeded', `${C}, Attachment 8, 2.0 - 2.3`, `Extremity dosimetry screening (${readings}): even with hands at the contact reading until the body reaches the ${fmt(wo.doseSetpoint)} mRem setpoint at the general area reading, the hands would receive about ${fmt(Math.round(bound))} mrem (${fmt(wo.contact)} / ${fmt(wo.generalArea)} x ${fmt(wo.doseSetpoint)}), below the 500 mrem criterion.`);
      else {
        const boundText = canBound ? ` Screening: with hands at the contact reading until the body reaches the ${fmt(wo.doseSetpoint)} mRem setpoint at the general area reading, the hands could receive about ${fmt(Math.round(bound))} mrem (${fmt(wo.contact)} / ${fmt(wo.generalArea)} x ${fmt(wo.doseSetpoint)}), which reaches the 500 mrem criterion.` : '';
        add('missing', `${C}, Attachment 8, 2.0 - 2.3`, `The WO does not say whether extremity dosimetry was evaluated (${readings}). At the contact dose rate, about ${duration(minutes)} of hand contact reaches the 500 mrem criterion.${boundText} The WO does not state whether hands will be near the source; RP should evaluate this before the job so dose to the hands is monitored and recorded.`);
      }
    }

    // Dose gradient: applies above 100 mrem/hour at 30 cm.
    if (workRate !== null) {
      if (workRate > 100 && !wo.multiBadging) add('missing', `${C}, Attachment 8, 1.0 - 1.2`, `The WO does not say whether dosimeter placement was evaluated for a dose gradient. The 30 cm dose rate of ${fmt(workRate)} mR/h is above 100 mrem/hour; dosimeters are repositioned or added if part of the whole body is expected to exceed the chest dose by more than 50 mrem during the entry.`);
      else if (workRate > 100) add('covered', `${C}, Attachment 8, 1.0 - 1.2`, 'Dosimeter placement for a dose gradient is addressed.');
      else add('notNeeded', `${C}, Attachment 8, 1.0 - 1.2`, `Dose gradient: the 30 cm dose rate of ${fmt(workRate)} mR/h is not above 100 mrem/hour.`);
    }

    // Senior Technician coverage.
    const senior = [];
    if (stayRequired) senior.push('stay time monitoring is required');
    if (wo.alphaLevel === 3) senior.push('the work enters a Level 3 Alpha Area');
    if (wo.diving) senior.push('the work is a diving activity');
    if (wo.radiography) senior.push('the work is radiography');
    if (wo.airborneWord && /grind|weld|machin/i.test(wo.airborneWord) && wo.contamination !== null && wo.contamination > 50000) senior.push(`${wo.airborneWord.toLowerCase()} on material with ${fmt(wo.contamination)} dpm/100 cm2, above 50,000 dpm/100 cm2`);
    if (senior.length && wo.seniorTechnician) add('covered', `${C}, Attachment 1`, 'A Senior Technician is assigned to the coverage.');
    else if (senior.length) add('missing', `${C}, Attachment 1`, `The WO does not state that a Senior Technician leads the job coverage. It applies because ${senior.join('; ')}. The ANSI standard that defines a Senior Technician is set by the site Technical Specifications or Quality Assurance Plan.`);

    if (wo.doseSetpoint !== null) add('duringJob', `${C}, 6.3.5`, `A worker leaves the area when cumulative dose exceeds 80% of the ${fmt(wo.doseSetpoint)} mRem setpoint, which is ${fmt(0.8 * wo.doseSetpoint)} mRem.`);
    else add('duringJob', `${C}, 6.3.5`, 'A worker leaves the area when cumulative dose exceeds 80% of the dose setpoint.');
  }

  if (has('002')) {
    const C = 'NISP-RP-002';

    if (wo.surveyNumber) add('covered', `${C}, 6.9.5`, `Survey ${wo.surveyNumber} is referenced.`);
    else if (wo.surveyDeferred) add('missing', `${C}, 6.9.5`, 'There is no completed survey for the work area: the WO plans the survey after the work starts.');
    else add('missing', `${C}, 6.9.5`, 'The WO does not reference a survey of the work area.');

    const absent = [['contact', wo.contact], ['30 cm', wo.at30cm], ['general area', wo.generalArea]].filter((r) => r[1] === null).map((r) => r[0]);
    if (absent.length === 0) add('covered', `${C}, 6.1.5, 6.1.6`, `Dose rates are stated: ${fmt(wo.contact)} mR/h contact, ${fmt(wo.at30cm)} mR/h at 30 cm, ${fmt(wo.generalArea)} mR/h general area.`);
    else add('missing', `${C}, 6.1.5, 6.1.6`, `Dose rates not stated: ${absent.join(', ')}.`);

    if (wo.contamination === null) add('missing', `${C}, 6.1.10, 6.5.1`, 'The contamination level of the work area is not stated, so the beta dose rate and discrete particle checks could not be made.');
    else {
      if (wo.contamination > 500000 && !/beta dose/i.test(text)) add('missing', `${C}, 6.1.10`, `Beta dose rates are not stated; they are measured because contamination of ${fmt(wo.contamination)} dpm/100 cm2 is above 500,000 dpm/100 cm2.`);
      else if (wo.contamination <= 500000) add('notNeeded', `${C}, 6.1.10`, `Beta dose rates: contamination of ${fmt(wo.contamination)} dpm/100 cm2 is not above 500,000 dpm/100 cm2.`);
      if (wo.contamination > 100000 && !/discrete|particle/i.test(text)) add('missing', `${C}, 6.5.1`, `The WO does not mention wiping for discrete radioactive particles, which applies because contamination of ${fmt(wo.contamination)} dpm/100 cm2 is above 100,000 dpm/100 cm2.`);
      else if (wo.contamination <= 100000) add('notNeeded', `${C}, 6.5.1`, `Discrete particle wipes: contamination of ${fmt(wo.contamination)} dpm/100 cm2 is not above 100,000 dpm/100 cm2.`);
    }

    if (wo.noHotSpots) add('covered', `${C}, 6.9.5 a`, 'The survey reports no hot spots.');
    if (wo.rateSetpoint !== null) add('duringJob', `${C}, 6.1.9`, `RP supervision is notified if measured dose rates deviate from the range on the Rad Work Permit (dose rate setpoint ${fmt(wo.rateSetpoint)} mR/h).`);
  }

  if (has('003')) {
    const C = 'NISP-RP-003';

    // Reasons that make air sampling apply.
    const reasons = [];
    const letters = [];
    if (wo.airborneWord) { reasons.push(`the task involves airborne-generating work ("${wo.airborneWord.toLowerCase()}")`); letters.push('a'); }
    if (wo.breachWord) { reasons.push(`the task breaches a radioactive system ("${wo.breachWord.toLowerCase()}")`); letters.push('b'); }
    const dReasons = [];
    if (wo.contamination !== null && wo.contamination > 100000 && wo.dryRemovable) dReasons.push(`dry removable contamination of ${fmt(wo.contamination)} dpm/100 cm2 is above 100,000 dpm/100 cm2`);
    if (wo.alphaLevel === 3) dReasons.push('the work is in an Alpha Level 3 Area');
    if (wo.alphaLevel === 2 && wo.airborneWord) dReasons.push('it is aggressive work in an Alpha Level 2 Area');
    if (dReasons.length) { reasons.push(...dReasons); letters.push('d'); }
    const airSource = `${C}, 6.1.3 ${letters.join(', ')}`;

    if (reasons.length && wo.airNegated) add('conflicts', airSource, `The WO says air sampling is not needed ("${wo.airLine}"), but it applies because ${reasons.join('; ')}.`);
    else if (reasons.length && !wo.airLine) add('missing', airSource, `The WO does not address air sampling, which applies because ${reasons.join('; ')}.`);
    else if (reasons.length && wo.airType && /general area/i.test(wo.airType) && !/work area|breathing zone/i.test(wo.airLine)) add('conflicts', `${airSource}; 5.2.1 - 5.2.3`, `The WO plans only a general area air sample ("${wo.airLine}"), but air sampling of the work applies because ${reasons.join('; ')}.`);
    else if (reasons.length) {
      add('covered', airSource, `Air sampling is planned ("${wo.airLine}").`);
      if (!wo.airType) add('missing', `${C}, 5.2.1 - 5.2.3`, 'The planned air sample type (breathing zone, work area or general area) is not stated.');
    } else if (wo.airLine && !wo.airNegated) add('covered', `${C}, 6.1.3`, `Air sampling is planned ("${wo.airLine}").`);
    else add('notNeeded', `${C}, 6.1.3`, 'Air sampling: none of the conditions read from the WO apply.');
    if (reasons.length && (wo.airNegated || !wo.airLine)) add('missing', `${C}, 5.2.1 - 5.2.3`, 'The planned air sample type (breathing zone, work area or general area) is not stated.');

    if (wo.alphaLevel !== null) add('covered', `${C}, 5.3.1 - 5.3.3`, `The area is identified as Alpha Level ${wo.alphaLevel}.`);
    else if (wo.alphaNotEvaluated) add('missing', `${C}, 5.3.1 - 5.3.3`, 'The WO says alpha contamination was not evaluated, so the Alpha Level of the area is unknown.');
    else add('missing', `${C}, 5.3.1 - 5.3.3`, 'The WO does not state the Alpha Level of the area.');

    const pasApplies = wo.alphaLevel === 3 || (wo.alphaLevel === 2 && Boolean(wo.airborneWord));
    const pasWhy = wo.alphaLevel === 3 ? 'the work is in an Alpha Level 3 Area' : 'it is aggressive work in an Alpha Level 2 Area';
    if (pasApplies && wo.pasNegated) add('conflicts', `${C}, 6.5.2 a, b, c`, `The WO says personal air samplers are not required, but they are issued because ${pasWhy}.`);
    else if (pasApplies && !wo.pasLine) add('missing', `${C}, 6.5.2 a, b, c`, `The WO does not address personal air samplers, which are issued because ${pasWhy}.`);
    else if (pasApplies) add('covered', `${C}, 6.5.2 a, b, c`, 'Personal air samplers are addressed.');

    add('duringJob', `${C}, 5.12`, 'If air sample results unexpectedly exceed 0.3 DAC: stop work, evacuate the affected area and notify RP supervision.');
    if (wo.alphaLevel !== null) {
      const limit = { 1: 'below 30,000', 2: 'below 300', 3: '50 or less' }[wo.alphaLevel];
      add('duringJob', `${C}, Attachment 2, step 20`, `Notify RP supervision immediately if an air sample ratio is ${limit} in this Alpha Level ${wo.alphaLevel} Area.`);
    }
  }

  // Fields the engine looked for and did not find. It never fills them in.
  const couldNotRead = [
    ['Rad Work Permit number', wo.radWorkPermit], ['accumulated dose setpoint', wo.doseSetpoint], ['dose rate setpoint', wo.rateSetpoint],
    ['coverage type', wo.coverage], ['contact dose rate', wo.contact], ['30 cm dose rate', wo.at30cm], ['general area dose rate', wo.generalArea],
    ['contamination level', wo.contamination], ['Alpha Level', wo.alphaLevel],
  ].filter((field) => field[1] === null).map((field) => field[0]);

  return {
    counts: { conflicts: out.conflicts.length, missing: out.missing.length },
    doseRateUsed: workRate === null ? null : `${fmt(workRate)} mR/h at 30 cm (field practice for maintenance on equipment)`,
    cardsApplied: reviewed.map((number) => `NISP-RP-${number}`),
    couldNotRead,
    ...out,
  };
}
