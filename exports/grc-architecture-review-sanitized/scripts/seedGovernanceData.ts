import { saveGovernanceDocument, saveScorecard } from '../src/utils/database';
import { walaPlusSalesGovernanceRules, qualityScorecardConfig } from '../src/utils/governanceRules';

async function seedData() {
  console.log('🚀 Seeding governance data...\n');
  
  try {
    console.log('📄 Saving ExampleOrg Sales Governance Document...');
    const govDoc = await saveGovernanceDocument({
      name: walaPlusSalesGovernanceRules.document.name,
      document_type: 'sales',
      version: walaPlusSalesGovernanceRules.document.version,
      file_path: 'attached_assets/WalaPlus_Sales_1.1_01.12.2025_EN_1764681400933.pdf',
      content_text: JSON.stringify(walaPlusSalesGovernanceRules, null, 2),
      rules_json: walaPlusSalesGovernanceRules,
      is_active: true
    });
    console.log(`✅ Governance document saved with ID: ${govDoc.id}\n`);
    
    console.log('📊 Saving Quality Scorecard Configuration...');
    const scorecard = await saveScorecard({
      name: qualityScorecardConfig.name,
      description: qualityScorecardConfig.description,
      dimensions: qualityScorecardConfig,
      is_active: true
    });
    console.log(`✅ Quality scorecard saved with ID: ${scorecard.id}\n`);
    
    console.log('🎉 All governance data seeded successfully!');
    console.log('\nSummary:');
    console.log(`  - Governance Document: "${govDoc.name}" (v${govDoc.version})`);
    console.log(`  - Quality Scorecard: "${scorecard.name}"`);
    console.log(`  - Framework: ${qualityScorecardConfig.framework}`);
    console.log(`  - Dimensions: People (${qualityScorecardConfig.dimensions.people.weight * 100}%), Process (${qualityScorecardConfig.dimensions.process.weight * 100}%), Governance (${qualityScorecardConfig.dimensions.governance.weight * 100}%)`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
}

seedData();
