const { writeFileSync } = require('fs');

module.exports = (result) => {
  const report = result.config.gasReporter;
  let output = "Gas Usage Report\n===============\n";
  
  Object.entries(reporter._data.methods).forEach(([method, data]) => {
    output += `${method.padEnd(40)} ${data.gasData.map(g => g.toString()).join(' | ')}\n`;
  });
  
  writeFileSync('gas-report.txt', output);
  console.log(output);
};