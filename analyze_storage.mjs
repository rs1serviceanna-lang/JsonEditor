
import fs from 'fs';
import path from 'path';

const storageDir = './metax_zero_webserver/storage';

function analyzeStorage() {
    if (!fs.existsSync(storageDir)) {
        console.error("Storage directory not found at:", storageDir);
        return;
    }
    const files = fs.readdirSync(storageDir);
    const dataFiles = new Set();
    const contractFiles = new Set();
    const errorFiles = [];

    files.forEach(file => {
        if (file.endsWith('.contract')) {
            contractFiles.add(file.replace('.contract', ''));
        } else {
            dataFiles.add(file);
        }
    });

    console.log('--- Storage Analysis Report ---');

    // 1. Dangling Data Files (missing contract)
    const missingContracts = [...dataFiles].filter(f => !contractFiles.has(f));
    if (missingContracts.length > 0) {
        console.log(`\n[!] Dangling Data Files (No .contract found): ${missingContracts.length}`);
        missingContracts.slice(0, 5).forEach(f => console.log(`  - ${f}`));
        if (missingContracts.length > 5) console.log(`  ... and ${missingContracts.length - 5} more.`);
    }

    // 2. Dangling Contract Files (missing data)
    const missingData = [...contractFiles].filter(f => !dataFiles.has(f));
    if (missingData.length > 0) {
        console.log(`\n[!] Dangling Contract Files (No data file found): ${missingData.length}`);
        missingData.forEach(f => console.log(`  - ${f}.contract`));
    }

    // 3. Files with internal error messages
    files.forEach(file => {
        const fullPath = path.join(storageDir, file);
        if (fs.statSync(fullPath).isFile() && fs.statSync(fullPath).size < 1000) {
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (content.includes('{"error":')) {
                    errorFiles.push(file);
                }
            } catch (e) { }
        }
    });

    if (errorFiles.length > 0) {
        console.log(`\n[!] Files containing error messages: ${errorFiles.length}`);
        errorFiles.forEach(f => console.log(`  - ${f}`));
    }

    // 4. Unusual filenames
    const unusual = files.filter(f => !/^[a-f0-9-]{36,}/i.test(f) && !f.endsWith('.contract') && f !== 'storage_files.txt');
    if (unusual.length > 0) {
        console.log(`\n[?] Unusual Filenames:`);
        unusual.forEach(f => console.log(`  - ${f}`));
    }
}

analyzeStorage();
