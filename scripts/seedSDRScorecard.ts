import { createScorecard } from '../src/utils/database';

const sdrScorecardData = {
  name: 'WalaPlus SDR Quality Scorecard v1.0',
  description: 'Comprehensive SDR call quality evaluation based on COPC principles and WalaPlus governance standards. Evaluates People, Process, and Governance dimensions.',
  crm_module: 'Leads',
  team_name: 'SDR',
  version: '1.0',
  is_active: true,
  dimensions: {
    dimensions: {
      people: {
        name: 'People',
        weight: 0.35,
        attributes: [
          {
            id: 'A1',
            name: 'Opening & Professional Introduction',
            weight: 0.10,
            severityIfFailed: 'major',
            description: 'Agent uses proper greeting, states name and company clearly, sets professional tone',
            passingCriteria: 'Professional greeting used, name clearly stated, company identified, purpose of call explained'
          },
          {
            id: 'A3',
            name: 'Discovery & Qualification Questions',
            weight: 0.15,
            severityIfFailed: 'critical',
            description: 'Asks relevant discovery questions, actively listens, identifies customer needs and pain points',
            passingCriteria: 'At least 3 discovery questions asked, active listening demonstrated, customer needs identified'
          },
          {
            id: 'A5',
            name: 'Product Knowledge',
            weight: 0.10,
            severityIfFailed: 'major',
            description: 'Demonstrates accurate product knowledge, answers questions confidently, explains features clearly',
            passingCriteria: 'Product information accurate, confident responses, features explained in customer terms'
          },
          {
            id: 'A7',
            name: 'Objection Handling',
            weight: 0.10,
            severityIfFailed: 'major',
            description: 'Addresses objections professionally, maintains composure, provides value-based responses',
            passingCriteria: 'Objections acknowledged and addressed, composure maintained, value proposition reinforced'
          }
        ]
      },
      process: {
        name: 'Process',
        weight: 0.35,
        attributes: [
          {
            id: 'A2',
            name: 'Call Structure & Control',
            weight: 0.10,
            severityIfFailed: 'major',
            description: 'Maintains call flow, manages time effectively, guides conversation purposefully',
            passingCriteria: 'Clear call structure followed, appropriate time management, conversation guided toward goal'
          },
          {
            id: 'A6',
            name: 'Value Proposition',
            weight: 0.15,
            severityIfFailed: 'critical',
            description: 'Clearly communicates value, aligns benefits to customer needs, differentiates from competitors',
            passingCriteria: 'Value clearly articulated, benefits aligned to needs, competitive advantages mentioned'
          },
          {
            id: 'A9',
            name: 'Closing & Next Steps',
            weight: 0.10,
            severityIfFailed: 'major',
            description: 'Clear next steps defined (meeting/follow-up/disqualification), customer understanding confirmed',
            passingCriteria: 'Next steps clearly stated, commitment obtained, follow-up scheduled or outcome documented'
          }
        ]
      },
      governance: {
        name: 'Governance',
        weight: 0.30,
        attributes: [
          {
            id: 'A4',
            name: 'Data Verification',
            weight: 0.10,
            severityIfFailed: 'critical',
            description: 'Verifies customer information, confirms contact details, updates CRM accurately',
            passingCriteria: 'Customer details verified, contact information confirmed, data captured for CRM'
          },
          {
            id: 'A8',
            name: 'Compliance & Professional Conduct',
            weight: 0.10,
            severityIfFailed: 'critical',
            description: 'Maintains professional tone throughout, no misleading statements, respectful language used',
            passingCriteria: 'Professional tone maintained, no policy violations, ethical conduct demonstrated'
          }
        ]
      }
    }
  }
};

async function seedSDRScorecard() {
  console.log('🌱 Creating WalaPlus SDR Quality Scorecard...');
  
  try {
    const { updateScorecard } = await import('../src/utils/database');
    
    const scorecardInput = {
      name: sdrScorecardData.name,
      description: sdrScorecardData.description,
      crm_module: sdrScorecardData.crm_module,
      team_name: sdrScorecardData.team_name,
      version: sdrScorecardData.version,
      dimensions: sdrScorecardData.dimensions
    };
    
    const scorecard = await createScorecard(scorecardInput);
    console.log('✅ SDR Scorecard created with ID:', scorecard.id);
    
    if (sdrScorecardData.is_active && scorecard.id) {
      await updateScorecard(scorecard.id, { is_active: true });
      console.log('✅ Scorecard activated!');
    }
    
    console.log(`   Name: ${scorecard.name}`);
    console.log(`   Team: ${scorecard.team_name}`);
    return scorecard;
  } catch (error) {
    console.error('❌ Failed to create scorecard:', error);
    throw error;
  }
}

seedSDRScorecard()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
