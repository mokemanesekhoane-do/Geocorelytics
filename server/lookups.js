// Controlled geotechnical vocabularies.
//
// Every field an operator would otherwise retype gets a category here. Seeded
// values are the industry-standard sets (USCS, ISRM weathering/strength, SANS
// consistency terms); operators pick from them instead of typing, which is what
// makes the captured data aggregatable in the analytics layer — free text
// cannot be grouped, counted, or trended.
//
// Seeds are inserted with is_seed = 1 and never overwritten on restart, so an
// admin's edits and approvals survive redeploys.

const CATEGORIES = {
  uscs_class: {
    label: 'USCS Classification',
    values: [
      'GW - Well-graded gravel', 'GP - Poorly-graded gravel', 'GM - Silty gravel', 'GC - Clayey gravel',
      'GW-GM', 'GP-GM', 'GW-GC', 'GP-GC',
      'SW - Well-graded sand', 'SP - Poorly-graded sand', 'SM - Silty sand', 'SC - Clayey sand',
      'SW-SM', 'SP-SM', 'SW-SC', 'SP-SC',
      'ML - Silt (low plasticity)', 'CL - Lean clay', 'OL - Organic silt/clay (low plasticity)',
      'MH - Elastic silt', 'CH - Fat clay', 'OH - Organic clay (high plasticity)',
      'CL-ML', 'PT - Peat',
    ],
  },
  soil_type: {
    label: 'Soil Type',
    values: [
      'Topsoil', 'Fill', 'Clay', 'Silt', 'Sand', 'Gravel', 'Cobbles', 'Boulders',
      'Sandy Clay', 'Silty Clay', 'Clayey Sand', 'Silty Sand', 'Gravelly Sand', 'Sandy Gravel',
      'Peat', 'Organic Soil', 'Residual Soil', 'Colluvium', 'Alluvium', 'Ferricrete', 'Calcrete',
    ],
  },
  soil_colour: {
    label: 'Soil Colour',
    values: [
      'Light Brown', 'Brown', 'Dark Brown', 'Reddish Brown', 'Yellowish Brown', 'Orange Brown',
      'Grey Brown', 'Light Grey', 'Grey', 'Dark Grey', 'Black', 'White', 'Cream',
      'Yellow', 'Orange', 'Red', 'Olive', 'Green Grey', 'Mottled', 'Speckled', 'Variegated',
    ],
  },
  consistency: {
    label: 'Consistency (cohesive)',
    values: ['Very Soft', 'Soft', 'Firm', 'Stiff', 'Very Stiff', 'Hard'],
  },
  density: {
    label: 'Density (granular)',
    values: ['Very Loose', 'Loose', 'Medium Dense', 'Dense', 'Very Dense'],
  },
  moisture: {
    label: 'Moisture Condition',
    values: ['Dry', 'Slightly Moist', 'Moist', 'Very Moist', 'Wet', 'Saturated'],
  },
  weathering: {
    label: 'Weathering Grade',
    values: [
      'W1 - Fresh', 'W2 - Slightly Weathered', 'W3 - Moderately Weathered',
      'W4 - Highly Weathered', 'W5 - Completely Weathered', 'W6 - Residual Soil',
    ],
  },
  rock_strength: {
    label: 'Rock Strength (ISRM)',
    values: [
      'R0 - Extremely Weak', 'R1 - Very Weak', 'R2 - Weak', 'R3 - Medium Strong',
      'R4 - Strong', 'R5 - Very Strong', 'R6 - Extremely Strong',
    ],
  },
  rock_type: {
    label: 'Rock Type / Lithology',
    values: [
      'Granite', 'Dolerite', 'Diabase', 'Basalt', 'Andesite', 'Rhyolite', 'Gabbro',
      'Sandstone', 'Siltstone', 'Mudstone', 'Shale', 'Conglomerate', 'Breccia',
      'Limestone', 'Dolomite', 'Chert', 'Coal',
      'Quartzite', 'Gneiss', 'Schist', 'Phyllite', 'Slate', 'Hornfels', 'Marble', 'Amphibolite',
      'Tillite', 'Norite', 'Anorthosite', 'Pegmatite',
    ],
  },
  sample_type: {
    label: 'Sample Type',
    values: ['SPT', 'Shelby', 'UDS', 'Disturbed', 'Bulk', 'Core', 'Water', 'Block'],
  },
  drilling_method: {
    label: 'Drilling Method',
    values: [
      'Rotary Core (Diamond)', 'Rotary Percussion', 'Air Percussion', 'Mud Rotary',
      'Auger - Hand', 'Auger - Flight', 'Auger - Hollow Stem', 'Wash Boring',
      'Sonic', 'ODEX / Symmetrix', 'Cable Tool / Percussion', 'Test Pit / TLB',
    ],
  },
  test_type: {
    label: 'In-Situ Test Type',
    values: [
      'Falling Head Test', 'Packer Test', 'Rising Head Test', 'Constant Head Test',
      'SPT', 'Vane Shear', 'CPT', 'DPSH', 'Pressuremeter', 'Plate Load Test', 'Permeability - Other',
    ],
  },
  recovery_quality: {
    label: 'Recovery Quality',
    values: ['Excellent (>95%)', 'Good (75-95%)', 'Fair (50-75%)', 'Poor (25-50%)', 'Very Poor (<25%)', 'No Recovery'],
  },
  fracture_condition: {
    label: 'Fracture Condition',
    values: [
      'Intact', 'Slightly Fractured', 'Moderately Fractured', 'Highly Fractured',
      'Crushed / Shattered', 'Blocky', 'Laminated', 'Sheared',
    ],
  },
  groundwater_obs: {
    label: 'Groundwater Observation',
    values: [
      'Dry', 'Not Encountered', 'Damp', 'Seepage', 'Slow Inflow', 'Rapid Inflow',
      'Water Strike', 'Standing Water', 'Artesian Flow', 'Perched Water Table', 'Water Loss to Formation',
    ],
  },
  equipment_status: {
    label: 'Equipment Status',
    values: ['Available', 'In Use', 'Standby', 'Under Maintenance', 'Awaiting Parts', 'Out of Service'],
  },
  drilling_status: {
    label: 'Drilling Status',
    values: [
      'Drilling', 'Casing', 'Tripping', 'Reaming', 'Standing', 'Rig Move',
      'Breakdown', 'Weather Delay', 'Complete', 'Abandoned',
    ],
  },
  downtime_reason: {
    label: 'Downtime Reason',
    values: [
      'None', 'Equipment Breakdown', 'Routine Maintenance', 'Weather', 'Waiting on Materials',
      'Waiting on Instruction', 'Waiting on Water', 'Shift Change', 'Rig Move / Setup',
      'Hole Problems / Collapse', 'Safety Stand-down', 'Access Restricted',
    ],
  },
  refusal_reason: {
    label: 'Refusal Reason',
    values: [
      'Target Depth Reached', 'Bedrock Refusal', 'Boulder / Cobble Obstruction',
      'Equipment Limitation', 'Hole Collapse', 'Excessive Water Loss',
      'Excessive Deviation', 'Client Instruction', 'Unsafe Conditions',
    ],
  },
  standard_remarks: {
    label: 'Standard Remarks',
    values: [
      'Drilling as planned', 'No anomalies observed', 'Core recovery lower than expected',
      'Water strike recorded', 'Hole cased to depth', 'Sample dispatched to laboratory',
      'Zone of poor recovery', 'Cavity / void encountered', 'Rig relocated',
      'Handover to next shift', 'Awaiting supervisor inspection',
    ],
  },
  shift: {
    label: 'Shift',
    values: ['Day', 'Night'],
  },
};

function seed(db) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO lookup_options (category, value, status, is_seed, sort_order)
     VALUES (?, ?, 'Approved', 1, ?)`
  );
  for (const [category, cfg] of Object.entries(CATEGORIES)) {
    cfg.values.forEach((value, i) => insert.run(category, value, i));
  }
}

module.exports = { CATEGORIES, seed };
