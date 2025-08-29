// src/process-image.ts
import { createWorker, Line, PSM } from 'tesseract.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

// Define a type for our question objects
interface Question {
  questionNumber: number;
  text: string;
  options: { key: string; text: string; }[];
}

// --- Recreate __dirname for ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const IMAGE_FILE_NAME = 'image.jpg';
const PREPROCESSED_LEFT_NAME = 'left-preprocessed.png';
const PREPROCESSED_RIGHT_NAME = 'right-preprocessed.png';
// -------------------

const imagePath = path.resolve(__dirname, '..', IMAGE_FILE_NAME);

if (!fs.existsSync(imagePath)) {
  console.error(`\nFATAL ERROR: Image file not found at path: ${imagePath}`);
  process.exit(1);
}

console.log(`Processing image from path: ${imagePath}`);

// Helper function to clean OCR text (expanded for more common errors)
function cleanOCRText(text: string): string {
  return text
    .replace(/cquation/g, 'equation')
    .replace(/cqual/g, 'equal')
    .replace(/r00t/g, 'root')
    .replace(/r0ot/g, 'root')
    .replace(/ro0t/g, 'root')
    .replace(/rnot/g, 'root')
    .replace(/rrot/g, 'root')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/\s*-\s*/g, '-')
    .replace(/ﬁ/g, 'fi') // ligatures
    .replace(/ﬂ/g, 'fl')
    .replace(/\[ /g, '[')
    .replace(/ \]/g, ']')
    .replace(/\( Shift/g, '(Shift')
    .replace(/\|\)/g, '1)') // misread 1 as |
    .replace(/O/g, '0') // careful, but common in numbers
    .replace(/l/g, '1') // common in math contexts
    .replace(/§/g, 'S')
    .replace(/\s+/g, ' ')
    .trim();
}

// Main processing function
(async () => {
  let worker;
  try {
    // --- Step 1: Get image metadata to determine dimensions for cropping ---
    const metadata = await sharp(imagePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Could not get image metadata.');
    }
    const halfWidth = Math.floor(metadata.width / 2);

    // Define crop regions for left and right columns (adjust margins if needed based on your image)
    const leftCrop = { left: 0, top: 0, width: halfWidth, height: metadata.height };
    const rightCrop = { left: halfWidth, top: 0, width: halfWidth, height: metadata.height };

    // --- Step 2: Preprocess and crop into left and right columns ---
    console.log('Preprocessing and cropping image with sharp...');

    // Left column
    await sharp(imagePath)
      .extract(leftCrop)
      .grayscale()
      .resize(leftCrop.width * 2, null, { kernel: 'lanczos3' }) // Upscale for better OCR resolution
      .normalize()
      .sharpen({ sigma: 1, m1: 0, m2: 3 }) // Stronger sharpen for text edges
      .threshold(135) // Binarize; adjust 100-150 based on trials
      .toFile(PREPROCESSED_LEFT_NAME);

    // Right column
    await sharp(imagePath)
      .extract(rightCrop)
      .grayscale()
      .resize(rightCrop.width * 2, null, { kernel: 'lanczos3' })
      .normalize()
      .sharpen({ sigma: 1, m1: 0, m2: 3 })
      .threshold(135)
      .toFile(PREPROCESSED_RIGHT_NAME);

    console.log(`Preprocessed columns saved to: ${PREPROCESSED_LEFT_NAME} and ${PREPROCESSED_RIGHT_NAME}`);

    // --- Step 3: Initialize Tesseract Worker ---
    worker = await createWorker('eng', 1, {
      logger: (m) => { if (m.status === 'recognizing text') console.log(`Progress: ${(m.progress * 100).toFixed(2)}%`) }
    });
    
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN, // Treat each as a single column of text
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-=()[]{}.,?!/\\^_*~|<>:"\'@ ',
    });

    // --- Step 4: Recognize Text from each preprocessed column ---
    console.log('Recognizing text from left column...');
    const leftData = await worker.recognize(PREPROCESSED_LEFT_NAME);
    const leftText = cleanOCRText(leftData.data.text);

    console.log('Recognizing text from right column...');
    const rightData = await worker.recognize(PREPROCESSED_RIGHT_NAME);
    const rightText = cleanOCRText(rightData.data.text);

    // Log raw OCR for debugging
    console.log('\n--- Raw Left Column Text ---\n' + leftText);
    console.log('\n--- Raw Right Column Text ---\n' + rightText);

    const fullText = leftText + '\n\n' + rightText; // Separate columns with double newline for readability

    if (!leftData.data.text || !rightData.data.text) {
      console.error("Error: Tesseract could not find any text in the image.");
      return;
    }

    // --- Step 5: Parse Questions from Text ---
    const questions: Question[] = [];
    const normalizedText = cleanOCRText(fullText)
      .replace(/\n+/g, ' ')
      .replace(/(\d+\.)\s+/g, '\n$1 ');
      
    const questionBlocks = normalizedText.split(/(?=\n?\d{1,2}\.\s+)/).filter(block => block.trim());

    for (const block of questionBlocks) {
      const qMatch = block.match(/^(\d{1,2})\.\s+(.*)/s);
      if (qMatch) {
        const qNum = parseInt(qMatch[1], 10);
        let content = qMatch[2].trim();
        content = content.replace(/\[\d{2}\s+\w+,\s+\d{4}\s+\(Shift-[I]+\)\]/gi, '').trim();
        
        const optionStartPattern = /([\(|a]\s*[a-d]\s*\))/i; // Made case-insensitive and flexible
        const parts = content.split(optionStartPattern);
        const questionText = cleanOCRText(parts[0]);
        
        const optionsText = content.substring(questionText.length);
        const optionMatches = [...optionsText.matchAll(/\s*([a-d])\)\s*(.*?)(?=\s*[a-d]\)|$)/gi)]; // Case-insensitive
        
        const options = optionMatches.map(match => ({
          key: match[1],
          text: cleanOCRText(match[2]),
        }));

        if (questionText.length > 10 && options.length > 1) {
          questions.push({
            questionNumber: qNum,
            text: questionText,
            options: options,
          });
        }
      }
    }

    const uniqueQuestions = questions.reduce((acc: Question[], q) => {
      if (!acc.some((existing) => existing.questionNumber === q.questionNumber)) {
        acc.push(q);
      }
      return acc;
    }, []).sort((a, b) => a.questionNumber - b.questionNumber);

    // --- Step 6: Output the final JSON ---
    const jsonResponse = {
      imageFile: IMAGE_FILE_NAME,
      questions: uniqueQuestions,
    };

    console.log('\n--- ✅ Structured OCR Result ---');
    console.log(JSON.stringify(jsonResponse, null, 2));
    
    const outputPath = path.join(__dirname, '..', 'ocr_output.json');
    fs.writeFileSync(outputPath, JSON.stringify(jsonResponse, null, 2));
    console.log(`\nOutput saved to: ${outputPath}`);

  } catch (error) {
    console.error('An error occurred during OCR processing:', error);
  } finally {
    if (worker) {
      await worker.terminate();
      console.log('Worker terminated.');
    }
    // Clean up preprocessed files
    [PREPROCESSED_LEFT_NAME, PREPROCESSED_RIGHT_NAME].forEach(file => {
      const filePath = path.resolve(__dirname, '..', file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }
})();