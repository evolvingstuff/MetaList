from setuptools import setup

def read_requirements():
    with open('requirements.txt') as req:
        return req.read().splitlines()

with open('README.md', 'r', encoding='utf-8') as fh:
    long_description = fh.read()

setup(
    name='MetaList',
    version='0.1.0',
    author='Your Name',
    author_email='your.email@example.com',
    description='A short description of your MetaList project',
    long_description=long_description,
    long_description_content_type='text/markdown',
    url='https://github.com/yourusername/metalist',
    install_requires=read_requirements(),
    classifiers=[
        'Programming Language :: Python :: 3',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
    ],
    # packages=['metalist'],  # Manually specifying your package directory
    package_data={
        'metalist': ['static/**/*'],
    },
    entry_points={
        'console_scripts': [
            'metalist=metalist.app:run_app',  # Points to the main function in metalist/app.py
        ],
    },
    python_requires='>=3.6',
)