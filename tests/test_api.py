import os
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import app


class AnswerApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = Path(self.tempdir.name) / 'questions.sqlite3'
        db_patch = patch.object(app, 'DB_PATH', self.db_path)
        db_patch.start()
        self.addCleanup(db_patch.stop)
        self.client = TestClient(app.app)
        self.question = {'text': 'Which option is correct?\nA. First option\nB. Second option'}

    @patch.dict(os.environ, {}, clear=True)
    def test_missing_key_returns_actionable_error(self):
        response = self.client.post('/api/answer', json=self.question)
        self.assertEqual(response.status_code, 503)
        self.assertIn('GEMINI_API_KEY', response.json()['detail'])
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute('SELECT question, status FROM scans').fetchone(), (self.question['text'], 'failed'))

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'}, clear=True)
    @patch('app.genai.Client')
    def test_structured_multiple_answers(self, client):
        api = client.return_value.__enter__.return_value.models.generate_content
        api.return_value = SimpleNamespace(
            text='{"choices":[{"position":"A","text":"First option"},{"position":"B","text":"Second option"}]}'
        )
        response = self.client.post('/api/answer', json=self.question)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([choice['position'] for choice in response.json()['choices']], ['A', 'B'])
        self.assertIn(self.question['text'], api.call_args.kwargs['contents'])
        self.assertEqual(api.call_args.kwargs['model'], 'gemini-3.5-flash-lite')
        with closing(sqlite3.connect(self.db_path)) as db:
            text, status, answer_json = db.execute('SELECT question, status, answer FROM scans').fetchone()
        self.assertEqual((text, status), (self.question['text'], 'answered'))
        self.assertEqual(json.loads(answer_json), response.json())

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'}, clear=True)
    @patch('app.genai.Client')
    def test_unlettered_choices_request_alphabetical_positions(self, client):
        api = client.return_value.__enter__.return_value.models.generate_content
        api.return_value = SimpleNamespace(text=json.dumps({'choices': [
            {'position': 'A', 'text': 'First option'},
            {'position': 'C', 'text': 'Third option'},
        ]}))
        question = {'text': 'Which two options are correct?\nFirst option\nSecond option\nThird option'}
        response = self.client.post('/api/answer', json=question)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([choice['position'] for choice in response.json()['choices']], ['A', 'C'])
        prompt = api.call_args.kwargs['contents']
        self.assertIn('first A, second B, third C, fourth D', prompt)
        self.assertIn('even when the choices on screen have no letters', prompt)
        self.assertIn('each selected answer as a separate choice', prompt)

    def test_choice_position_must_be_a_single_uppercase_letter(self):
        for invalid in ('1', 'A, B', 'a', ''):
            with self.subTest(position=invalid), self.assertRaises(ValueError):
                app.Choice(position=invalid, text='Answer')

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'}, clear=True)
    @patch('app.genai.Client')
    def test_provider_failure_does_not_expose_details(self, client):
        client.return_value.__enter__.return_value.models.generate_content.side_effect = RuntimeError('private provider details')
        response = self.client.post('/api/answer', json=self.question)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('private provider details', response.text)

    @patch.dict(os.environ, {'GEMINI_API_KEY': 'test-key'}, clear=True)
    @patch('app.genai.Client')
    def test_retries_share_a_record_but_returned_questions_are_recorded_again(self, client):
        api = client.return_value.__enter__.return_value.models.generate_content
        api.side_effect = [RuntimeError('temporary'), SimpleNamespace(text='{"choices":[{"position":"A","text":"First option"}]}'),
                           SimpleNamespace(text='{"choices":[{"position":"A","text":"First option"}]}')]
        first = {**self.question, 'scan_id': 'd9170c7a-7e03-4125-b329-bfda713aa34e'}
        second = {**self.question, 'scan_id': '8bc54383-e0d4-4967-97c1-dd1e71aa06cb'}
        self.assertEqual(self.client.post('/api/answer', json=first).status_code, 502)
        self.assertEqual(self.client.post('/api/answer', json=first).status_code, 200)
        self.assertEqual(self.client.post('/api/answer', json=second).status_code, 200)
        with closing(sqlite3.connect(self.db_path)) as db:
            rows = db.execute('SELECT question, status FROM scans').fetchall()
        self.assertEqual(rows, [(self.question['text'], 'answered'), (self.question['text'], 'answered')])

    def test_phone_progress_events_are_logged_without_question_text(self):
        with self.assertLogs('uvicorn.error', level='INFO') as logs:
            response = self.client.post('/api/events', json={
                'name': 'ocr_result', 'characters': 72, 'lines': 4, 'outcome': 'confirming',
            })
        self.assertEqual(response.status_code, 204)
        self.assertIn('72 characters', logs.output[0])
        self.assertIn('confirming', logs.output[0])
        self.assertNotIn(self.question['text'], logs.output[0])
        self.assertEqual(self.client.post('/api/events', json={'name': 'unexpected'}).status_code, 422)

    @patch.dict(os.environ, {'GOOGLE_VISION_KEY_PATH': 'example.json'}, clear=True)
    @patch('app.vision_credentials')
    @patch('app.AuthorizedSession')
    def test_cloud_vision_extracts_text_from_snapshot(self, session, credentials):
        provider = session.return_value.__enter__.return_value.post.return_value
        provider.json.return_value = {'responses': [{'fullTextAnnotation': {'text': 'Example question'}}]}
        response = self.client.post('/api/ocr', json={'image': 'dGVzdA=='})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'text': 'Example question'})
        credentials.assert_called_once_with('example.json')

    @patch.dict(os.environ, {'GOOGLE_VISION_KEY_PATH': 'example.json'}, clear=True)
    def test_cloud_vision_rejects_invalid_snapshot(self):
        response = self.client.post('/api/ocr', json={'image': 'not-valid-base64!'})
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
