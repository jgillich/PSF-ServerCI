import * as fs from 'fs'
export default JSON.parse(fs.readFileSync('config.json'));
